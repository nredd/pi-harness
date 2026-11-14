/**
 * The `/stats` overlay: Claude Code's Stats pane rebuilt over pi sessions. Overview has the activity
 * heatmap, headline numbers and the token chart; Models has the chart and the per-model breakdown
 * grouped by provider. `r` cycles the date range, `h` the harness (pi, Claude Code, Codex, OpenCode),
 * `m` / `M` the provider/model filter. Overview shows the subscription quota readings above the chart.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	type Color,
	type Component,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { sanitize } from "../diff/view.ts";
import {
	chartSeries,
	dailySeries,
	dailyTotals,
	type Filter,
	filterCycle,
	filterLabel,
	harnessesOf,
	hourlySeries,
	inRange,
	isHourly,
	type ModelTotals,
	matches,
	modelTotals,
	type Overview,
	overview,
	RANGE_LABEL,
	RANGES,
	type Range,
	rangeStart,
	seriesKey,
	TOKENS_NOTE,
	tokensOf,
} from "./aggregate.ts";
import { bucketize, GUTTER, plot, TICKS } from "./chart.ts";
import { dayKey, keyDate, shortDate } from "./days.ts";
import { costLabel, duration, formatTokens, percent } from "./format.ts";
import type { QuotaObservation } from "./harness/common.ts";
import { DAY_LABEL_WIDTH, heatmap, MAX_WEEKS, MONTH_OVERFLOW, weeksFor, YEAR_WEEKS } from "./heatmap.ts";
import { type Call, HARNESSES, type Harness, type Session } from "./load.ts";
import { nth } from "./nth.ts";
import { seriesPalette } from "./palette.ts";
import { claudeHasNoReading, gauge, NO_LOCAL_READING, quotaRows, usedLabel } from "./quota.ts";
import { timeAxis } from "./ticks.ts";

type ThemeLike = Pick<Theme, "fg" | "bg" | "bold" | "style" | "colors">;
export type Tab = "Overview" | "Models" | "Machines";
const TABS: readonly Tab[] = ["Overview", "Models", "Machines"];
/** Chart lines, at most; their colours are shared by the chart, its legend and the model list. */
const SERIES = 3;
/** The provider Claude Code's quota would belong to. */
const ANTHROPIC = "anthropic (Claude Code)";
/** The harness filter: every harness, or one. */
type HarnessFilter = "all" | Harness;
/** Narrowest plot `plot` can draw; only panes too narrow for a 6-week heatmap hit it. */
const MIN_PLOT_WIDTH = 2;

/** Columns every block spans in a `paneWidth` pane: all of it after the 1-column margin. */
export function contentWidth(paneWidth: number): number {
	return Math.max(1, paneWidth - 1);
}

/** Tallest chart, in rows above the zero line. */
const MAX_CHART_HEIGHT = 40;

/** Chart rows for `available` lines: whole tick steps (so every tick is a row), 5 to 40. */
export function chartHeight(available: number): number {
	const steps = Math.floor(available / TICKS) * TICKS;
	return Math.max(TICKS, Math.min(MAX_CHART_HEIGHT, steps));
}

/** Columns between the heatmap and the numbers beside it, and between number columns. */
const GAP = 4;

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
	/** Offline per-source provenance, rendered as a scrollable Machines tab. */
	freshness?: readonly string[];
	/** Merged subscription quota readings, shown at the end of Overview. */
	quota?: readonly QuotaObservation[];
	tab?: Tab;
}

/** One scroll step of the model list: a provider header, or one or two models side by side. */
/** Per-provider or per-model sums the list shows. */
type Totals = Pick<ModelTotals, "input" | "output" | "cacheRead" | "cacheWrite" | "cost" | "unpriced" | "calls">;

interface ListRow {
	lines: string[];
	/** Positions of its models in list order, for the `1-4 of N` hint. */
	models: number[];
}

export class StatsView implements Component {
	private tab: Tab;
	private range: Range = "all";
	private filterIndex = 0;
	private harnessIndex = 0;
	private scroll = 0;
	private readonly palettes = new Map<number, Color[]>();
	private readonly counted: Call[];
	/** `all`, then every harness with data; just `all` when one harness is all there is to choose. */
	private readonly harnesses: HarnessFilter[];
	private readonly filtersByHarness = new Map<HarnessFilter, Filter[]>();
	private readonly today: string;
	private readonly now: number;

	constructor(private readonly o: StatsViewOptions) {
		this.tab = o.tab ?? "Overview";
		this.now = o.now ?? Date.now();
		this.counted = o.calls.filter((c) => c.ms <= this.now);
		const present = harnessesOf(this.counted);
		this.harnesses = present.length > 1 ? ["all", ...present] : ["all"];
		this.today = o.today ?? dayKey(this.now);
	}

	invalidate(): void {
		// Nothing themed is cached: every render rebuilds colours from the live theme.
	}

	get state(): { tab: Tab; range: Range; filter: Filter; harness: HarnessFilter; scroll: number } {
		return { tab: this.tab, range: this.range, filter: this.filter, harness: this.harness, scroll: this.scroll };
	}

	private get harness(): HarnessFilter {
		return nth(this.harnesses, this.harnessIndex);
	}

	/** Provider and model choices for the calls the harness filter lets through. */
	private get filters(): Filter[] {
		let filters = this.filtersByHarness.get(this.harness);
		if (!filters) {
			filters = filterCycle(this.counted.filter((c) => this.inHarness(c)));
			this.filtersByHarness.set(this.harness, filters);
		}
		return filters;
	}

	private inHarness(c: Pick<Call, "harness">): boolean {
		return this.harness === "all" || c.harness === this.harness;
	}

	/** Whether harnesses are told apart on screen: several have data and none is picked. */
	private get splitHarness(): boolean {
		return this.harness === "all" && this.harnesses.length > 1;
	}

	private get filter(): Filter {
		return nth(this.filters, this.filterIndex);
	}

	// --- input -------------------------------------------------------------------------------

	handleInput(data: string): void {
		if (data === "q" || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.o.onClose();
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
			this.tab = cycle(TABS, this.tab, matchesKey(data, Key.shift("tab")) ? -1 : 1);
			this.scroll = 0;
		} else if (data === "r") {
			this.range = cycle(RANGES, this.range, 1);
			this.scroll = 0;
		} else if (data === "h" || data === "H") this.stepHarness(data === "h" ? 1 : -1);
		else if (data === "m") this.stepFilter(1);
		else if (data === "M" || matchesKey(data, Key.shift("m"))) this.stepFilter(-1);
		else if (data === "j" || matchesKey(data, Key.down)) this.scroll++;
		else if (data === "k" || matchesKey(data, Key.up)) this.scroll = Math.max(0, this.scroll - 1);
		else return;
		this.o.requestRender();
	}

	/** Next harness; the provider/model filter stays when that harness has it, else falls back to All. */
	private stepHarness(delta: number): void {
		const kept = JSON.stringify(this.filter);
		const n = this.harnesses.length;
		this.harnessIndex = (((this.harnessIndex + delta) % n) + n) % n;
		this.filterIndex = Math.max(
			0,
			this.filters.findIndex((f) => JSON.stringify(f) === kept),
		);
		this.scroll = 0;
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
		const header = this.header(contentWidth(w), rows);
		const room = Math.max(0, rows - header.length - 2);
		let body: string[];
		let hint = "";
		if (this.tab === "Overview") body = this.scrolled(this.overviewBody(w, room), room);
		else if (this.tab === "Machines")
			body = this.scrolled(
				(this.o.freshness ?? ["Per-machine freshness unknown (no source metadata)."]).flatMap((line) =>
					wrapTextWithAnsi(this.paint("muted", line), contentWidth(w)),
				),
				room,
			);
		else {
			const models = this.modelsBody(w, room);
			body = this.scrolled(models.lines, room);
			hint = this.modelHint(models.owners.slice(this.scroll, this.scroll + room), models.count);
		}
		while (body.length < room) body.push("");
		return [...header, ...body, "", this.help(hint)].map((line) => truncateToWidth(` ${line}`, w, ""));
	}

	/**
	 * Tabs and warning with the coverage note flush right, then the range and filter (what `r` and `m`
	 * change), then a rule. Pinned above the scrolling body. Coverage drops under the selectors when the
	 * tabs row cannot hold it; on a very short pane the rule goes first.
	 */
	private header(inner: number, rows: number): string[] {
		const coverage = this.paint("muted", this.o.coverage ?? "local-only · never synced");
		const tabs = this.tabsLine();
		const joined = spread(tabs, coverage, inner);
		const lines = [
			joined ?? tabs,
			...(this.tab === "Machines" ? [] : this.selectors(inner)),
			...(joined ? [] : [coverage]),
			this.paint("dim", "─".repeat(inner)),
		];
		return lines.slice(0, Math.max(2, Math.min(lines.length, rows - 2)));
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
		return this.o.theme.style(sanitize(text), { fg: nth(palette, index) });
	}

	private tabsLine(): string {
		const t = this.o.theme;
		const tabs = TABS.map((tab) => (tab === this.tab ? t.bg("selectedBg", t.bold(` ${tab} `)) : ` ${tab} `)).join(" ");
		const bad = this.o.badLines ? `  ${this.paint("warning", `! ${this.o.badLines} unreadable lines`)}` : "";
		return `${t.bold(this.paint("accent", "/stats"))}  ${tabs}${bad}`;
	}

	/**
	 * Range choices, the harness (when there is a choice) and the filter on one line; when they do not fit,
	 * the harness drops under the ranges and the filter onto its own line.
	 */
	private selectors(inner: number): string[] {
		const t = this.o.theme;
		const ranges = RANGES.map((r) =>
			r === this.range ? t.bold(this.paint("accent", RANGE_LABEL[r])) : this.paint("dim", RANGE_LABEL[r]),
		).join(this.paint("dim", " · "));
		const harness =
			this.harnesses.length > 1
				? `${this.paint("muted", "harness:")} ${t.bold(this.harness === "all" ? "All" : this.harness)}`
				: "";
		const filter = `${this.paint("muted", "filter:")} ${t.bold(sanitize(filterLabel(this.filter)))}`;
		const gap = "    ";
		const line = [ranges, harness, filter].filter(Boolean).join(gap);
		if (visibleWidth(line) <= inner) return [line];
		const top = harness ? `${ranges}${gap}${harness}` : ranges;
		const fits = visibleWidth(top) <= inner;
		return [fits ? top : ranges, ...(fits || !harness ? [] : [harness]), truncateToWidth(filter, inner, "…")];
	}

	/** Muted `parts` joined by a dim ` · `, wrapped onto more lines rather than cut. */
	private wrapParts(parts: readonly string[], inner: number): string[] {
		const sep = this.paint("dim", " · ");
		const lines: string[] = [];
		let line = "";
		for (const part of parts.map((p) => this.paint("muted", p))) {
			if (line && visibleWidth(line) + 3 + visibleWidth(part) > inner) {
				lines.push(line);
				line = "";
			}
			line += (line ? sep : "") + part;
		}
		lines.push(line);
		return lines.map((l) => truncateToWidth(l, inner, "…"));
	}

	private help(hint: string): string {
		const picker = this.harnesses.length > 1 ? "h harness · " : "";
		const keys = this.paint("dim", `tab tabs · r dates · ${picker}m/M filter · ↑↓ scroll · q close`);
		return hint ? `${this.paint("muted", hint)}  ${keys}` : keys;
	}

	private scoped(): { all: Call[]; ranged: Call[] } {
		const all = this.o.calls.filter(
			(c) => this.inHarness(c) && matches(this.filter, c) && inRange("all", this.today, c.ms, this.now),
		);
		return { all, ranged: all.filter((c) => inRange(this.range, this.today, c.ms, this.now)) };
	}

	/**
	 * Headline numbers as `label  value` cells, in reading order: favorite model and total tokens,
	 * sessions and longest session, and so on.
	 */
	private statCells(ov: Overview): { label: string; value: string }[] {
		const t = this.o.theme;
		const v = (s: string) => this.paint("accent", s);
		// Only called for a non-empty range, so the overview has a favorite model and a most active day.
		const days = (n: number) => `${t.bold(v(String(n)))} ${n === 1 ? "day" : "days"}`;
		return [
			{ label: "Favorite model", value: t.bold(v(ov.favorite as string)) },
			{ label: "Total tokens", value: `${v(formatTokens(ov.totalTokens))} ${this.paint("muted", TOKENS_NOTE)}` },
			{ label: "Sessions", value: v(String(ov.sessions)) },
			{ label: "Longest session", value: v(duration(ov.longestSessionMs)) },
			{ label: "Active days", value: `${v(String(ov.activeDays))}${this.paint("muted", `/${ov.rangeDays}`)}` },
			{ label: "Longest streak", value: days(ov.longestStreak) },
			{ label: "Most active day", value: v(shortDate(ov.mostActiveDay as string)) },
			{ label: "Current streak", value: days(ov.currentStreak) },
			{
				label: "Cache tokens",
				value: `${v(formatTokens(ov.cacheRead))} read · ${v(formatTokens(ov.cacheWrite))} write`,
			},
			{ label: "Notional cost", value: v(costLabel(ov.cost, ov.unpriced, ov.calls)) },
		];
	}

	/**
	 * Cells in `columns` columns, row-major, each column's labels and values aligned; `columns` shrinks
	 * until the grid fits `width`.
	 */
	private statGrid(cells: readonly { label: string; value: string }[], width: number, columns: number): string[] {
		const widthOf = (cols: number) => {
			const per = Array.from({ length: cols }, (_, c) => cells.filter((_, i) => i % cols === c));
			// Every label is padded to the column's longest, so a cell is that plus the widest value.
			return per.map((col) => {
				const label = Math.max(0, ...col.map((x) => x.label.length));
				return { label, cell: label + 2 + Math.max(0, ...col.map((x) => visibleWidth(x.value))) };
			});
		};
		let cols = Math.max(1, Math.min(columns, cells.length));
		while (cols > 1 && widthOf(cols).reduce((n, c) => n + c.cell, 0) + GAP * (cols - 1) > width) cols--;
		const sizes = widthOf(cols);
		const out: string[] = [];
		for (let r = 0; r < cells.length; r += cols) {
			out.push(
				cells
					.slice(r, r + cols)
					.map((cell, c) => {
						const size = nth(sizes, c);
						const text = `${this.paint("muted", cell.label.padEnd(size.label))}  ${cell.value}`;
						return c < cols - 1 ? padTo(text, size.cell + GAP) : text;
					})
					.join(""),
			);
		}
		return out.map((line) => truncateToWidth(line, width, "…"));
	}

	/**
	 * One row per quota window: gauge, percent used, reset time and how old the reading is, dimmed past 15
	 * minutes. Account-wide, so the harness, model and range filters do not apply. A window that has reset
	 * shows no percent. Empty when there is nothing to say.
	 */
	private quotaBlock(inner: number): string[] {
		const readings = this.o.quota ?? [];
		const rows = quotaRows(readings, this.now);
		const noClaude = claudeHasNoReading(
			readings,
			this.counted.some((c) => c.harness === "claude"),
		);
		if (rows.length === 0 && !noClaude) return [];
		const t = this.o.theme;
		const out = ["", t.bold("Quota") + this.paint("muted", "  latest reading per window · local files, never fetched")];
		const labelWidth = Math.max(...rows.map((r) => visibleWidth(sanitize(r.label))), noClaude ? ANTHROPIC.length : 0);
		const pad = (label: string) => `  ${padTo(sanitize(label), labelWidth)}  `;
		for (const row of rows) {
			const tone: ThemeColor = row.old || row.expired ? "dim" : "muted";
			const detail = this.paint(tone, `${row.reset} · ${row.observed}`);
			const head = row.expired
				? ""
				: `${this.paint(row.old ? "dim" : "accent", gauge(row.usedPercent))} ${this.paint(tone, usedLabel(row.usedPercent).padStart(5))}`;
			const label = this.paint(row.old || row.expired ? "dim" : "text", pad(row.label));
			const joined = `${label}${head}${head ? "  " : ""}${detail}`;
			if (visibleWidth(joined) <= inner) out.push(joined);
			else
				out.push(
					truncateToWidth(`${label}${head}`.trimEnd(), inner, "…"),
					truncateToWidth(`    ${detail}`, inner, "…"),
				);
		}
		if (noClaude) out.push(this.paint("muted", `${pad(ANTHROPIC)}${NO_LOCAL_READING}`));
		return out;
	}

	private overviewBody(width: number, room: number): string[] {
		const { all, ranged } = this.scoped();
		const inner = contentWidth(width);
		const out: string[] = [];
		const quota = this.quotaBlock(inner);
		const daily = dailyTotals(all);
		const showHeat = !isHourly(this.range);
		if (ranged.length === 0 && !showHeat) return [this.paint("muted", "No usage in this range."), ...quota];
		const cells =
			ranged.length === 0
				? []
				: this.statCells(overview(ranged, this.o.sessions, this.range, this.today, daily.keys()));
		const heat = (area: number) =>
			heatmap(daily, this.today, area, (color, text) =>
				color === "heat" ? this.paint("accent", text) : this.paint(color === "empty" ? "dim" : "muted", text),
			);
		if (showHeat) {
			// Numbers beside the heatmap when a year of it still fits next to them, else underneath.
			const column = this.statGrid(cells, inner, 1);
			const beside = Math.max(0, ...column.map(visibleWidth));
			const area = Math.min(inner - GAP - beside, DAY_LABEL_WIDTH + MAX_WEEKS + MONTH_OVERFLOW);
			if (cells.length > 0 && weeksFor(area) >= YEAR_WEEKS) {
				const left = heat(area);
				// The heatmap (9 rows) is always shorter than the 10-cell column, so the column sets the height.
				for (const [i, cell] of column.entries()) out.push(`${padTo(left[i] ?? "", area + GAP)}${cell}`.trimEnd());
			} else {
				out.push(...heat(inner));
				if (cells.length > 0) out.push("", ...this.statGrid(cells, inner, 2));
			}
		} else out.push(...this.statGrid(cells, inner, width >= 130 ? 3 : 2));
		out.push(...quota);
		if (ranged.length === 0) {
			out.push("", this.paint("muted", "No usage in this range."));
			return out;
		}
		// Grow the chart into whatever the pane has left, in whole tick steps.
		const smallest = this.chart(ranged, width, TICKS).lines;
		const height = chartHeight(room - out.length - 1 - smallest.length + TICKS);
		out.push("", ...(height === TICKS ? smallest : this.chart(ranged, width, height).lines));
		return out;
	}

	/**
	 * Title, legend, plot, time axis and a peak/average caption. One line per provider under the "all"
	 * filter (one per harness when several have data and none is picked), else one per model; top three. The legend shares the title row when both fit.
	 */
	private chart(
		ranged: readonly Call[],
		width: number,
		height: number,
	): { lines: string[]; colors: Map<string, number> } {
		const t = this.o.theme;
		const inner = contentWidth(width);
		const byHarness = this.splitHarness && this.filter.kind === "all";
		const { by, keys: top } = chartSeries(this.filter, ranged, byHarness ? HARNESSES.length : SERIES, byHarness);
		const colors = new Map(top.map((k, i): [string, number] => [k.key, i]));
		const hourly = isHourly(this.range);
		const unit = hourly ? "hour" : undefined;
		const title = (name: string) => t.bold(name) + this.paint("muted", `  ${TOKENS_NOTE} · by ${by}`);
		const legend = this.legend(
			top.map((k) => k.key),
			inner,
		);
		const head = (name: string): string[] => {
			const row = legend.length === 1 ? spread(title(name), legend.join(""), inner) : undefined;
			if (row) return [row];
			// A pane too narrow for the title splits the name from its unit note.
			const lines =
				visibleWidth(title(name)) <= inner
					? [title(name)]
					: [t.bold(name), this.paint("muted", truncateToWidth(`${TOKENS_NOTE} · by ${by}`, inner, "…"))];
			return [...lines, ...legend];
		};
		const paint = (color: number | "axis", text: string) =>
			color === "axis" ? this.paint("muted", text) : this.paintSeries(color, top.length, text);
		const plotWidth = Math.max(MIN_PLOT_WIDTH, inner - GUTTER);
		if (hourly) {
			const series = hourlySeries(ranged, this.range as "5h" | "24h", this.now, seriesKey(by));
			const p = plot(
				top.map((k, i) => ({ values: series.map((s) => s.byKey.get(k.key) ?? 0), color: i })),
				{ width: plotWidth, height, paint },
			);
			const axis = timeAxis(
				series.map((s) => s.ms),
				{ kind: "hour" },
				plotWidth,
				p.gutter,
			);
			const out = [...head(`Tokens per ${unit}`), ...p.lines, ...axis.lines.map((l) => this.paint("muted", l))];
			out.push(...this.wrapParts([`From: ${series[0]?.day}`, `To: ${series.at(-1)?.day}`], inner));
			// Repeated wall-clock hours get an explicit offset-bearing label, even between axis edges.
			const labels = new Map<string, string>();
			for (const point of series) {
				const local = point.day.replace(/ UTC.*$/, "");
				const prior = labels.get(local);
				if (prior)
					out.push(this.paint("muted", `Repeated hour: ${prior}`), this.paint("muted", `               ${point.day}`));
				labels.set(local, point.day);
			}
			const peak = Math.max(0, ...series.map((s) => s.total));
			const avg = series.reduce((n, s) => n + s.total, 0) / series.length;
			out.push(
				...this.wrapParts(
					[`total: peak ${formatTokens(peak)}/hour`, `avg ${formatTokens(avg)}/hour`, "partial edges"],
					inner,
				),
			);
			return { lines: out, colors };
		}
		const from = rangeStart(this.range, this.today) ?? dayKey(nth(ranged, 0).ms);
		const series = dailySeries(ranged, from, this.today, seriesKey(by));
		const byDay = new Map(series.map((p) => [p.day, top.map((k) => p.byKey.get(k.key) ?? 0)]));
		// `series` holds every day from `from` to today, so `byDay` has every day `bucketize` asks for.
		const bucketed = bucketize(from, this.today, (d) => byDay.get(d) as number[], top.length, plotWidth + 1);
		const out = head(`Tokens per ${bucketed.unit}`);
		if (series.length < 2) {
			out.push(this.paint("muted", "Not enough data for a chart yet"));
			return { lines: out, colors };
		}
		const p = plot(
			top.map((_k, i) => ({
				values: bucketed.buckets.map((b) => nth(b.values, i)),
				color: i,
			})),
			{ width: plotWidth, height, paint },
		);
		const axis = timeAxis(
			bucketed.buckets.map((b) => keyDate(b.start).getTime()),
			{ kind: "day", size: bucketed.size },
			plotWidth,
			p.gutter,
		);
		out.push(...p.lines, ...axis.lines.map((l) => this.paint("muted", l)));
		const peak = series.reduce((best, point) => (point.total > best.total ? point : best));
		const avg = series.reduce((n, point) => n + point.total, 0) / series.length;
		out.push(
			...this.wrapParts(
				[`total: peak ${formatTokens(peak.total)} on ${shortDate(peak.day)}`, `avg ${formatTokens(avg)}/day`],
				inner,
			),
		);
		return { lines: out, colors };
	}

	/** `● a · ● b · ● c`, wrapped onto more lines rather than cutting a series name off. */
	private legend(keys: readonly string[], width: number): string[] {
		const sepText = " · ";
		const lines: string[] = [];
		let line = "";
		let used = 0;
		for (const [index, key] of keys.entries()) {
			const cell = `${this.paintSeries(index, keys.length, "●")} ${sanitize(key)}`;
			const cellWidth = 2 + visibleWidth(sanitize(key));
			if (used > 0 && used + sepText.length + cellWidth > width) {
				lines.push(line);
				line = "";
				used = 0;
			}
			line += used > 0 ? `${this.paint("dim", sepText)}${cell}` : cell;
			used += (used > 0 ? sepText.length : 0) + cellWidth;
		}
		lines.push(line);
		return lines;
	}

	/**
	 * Chart and the model list, scrolled as one body like Overview so even a short pane reaches every
	 * model. `owners[i]` holds the list positions of the models drawn on line `i`.
	 */
	private modelsBody(width: number, room: number): { lines: string[]; owners: number[][]; count: number } {
		const { ranged } = this.scoped();
		const totals = modelTotals(ranged);
		if (totals.length === 0) {
			const lines = [this.paint("muted", "No usage in this range.")];
			return { lines, owners: lines.map(() => []), count: 0 };
		}
		// The list scrolls under the chart: the chart gets what a short list leaves, at least half the pane.
		const colors = this.chart(ranged, width, TICKS).colors;
		const list = this.listRows(totals, contentWidth(width), colors);
		const listLines = list.reduce((n, row) => n + row.lines.length, 0);
		const chart = this.chart(ranged, width, chartHeight(Math.max(Math.floor(room / 2), room - listLines) - 7));
		const head = [...chart.lines, ""];
		return {
			lines: [...head, ...list.flatMap((row) => row.lines)],
			owners: [...head.map(() => []), ...list.flatMap((row) => row.lines.map(() => row.models))],
			count: totals.length,
		};
	}

	/**
	 * Models grouped under their provider: a table when its columns fit, one aligned line per model with a
	 * provider subtotal line above its models, else three-line cards one per row. Indented two columns.
	 */
	private listRows(totals: readonly ModelTotals[], inner: number, colors: ReadonlyMap<string, number>): ListRow[] {
		const t = this.o.theme;
		const grand = totals.reduce((n, m) => n + tokensOf(m), 0);
		const bullet = (key: string) => {
			const index = colors.get(key);
			return index === undefined ? this.paint("muted", "•") : this.paintSeries(index, colors.size, "•");
		};
		const sumOf = (models: readonly ModelTotals[]): Totals => ({
			input: models.reduce((n, m) => n + m.input, 0),
			output: models.reduce((n, m) => n + m.output, 0),
			cacheRead: models.reduce((n, m) => n + m.cacheRead, 0),
			cacheWrite: models.reduce((n, m) => n + m.cacheWrite, 0),
			cost: models.reduce((n, m) => n + m.cost, 0),
			unpriced: models.reduce((n, m) => n + m.unpriced, 0),
			calls: models.reduce((n, m) => n + m.calls, 0),
		});
		const providers = [...new Set(totals.map((m) => m.provider))].map((provider) => {
			const models = totals.filter((m) => m.provider === provider);
			const sub = sumOf(models);
			return {
				provider,
				models,
				sub,
				sum: models.reduce((n, m) => n + tokensOf(m), 0),
				via: HARNESSES.filter((h) => models.some((m) => m.harnesses.includes(h))),
			};
		});
		const rows: ListRow[] = [];
		let position = 0;
		const split = this.splitHarness;
		const numbers = (m: Totals, sum: number, via: readonly Harness[]) => [
			...(split ? [via.join(",")] : []),
			formatTokens(sum),
			percent(sum, grand),
			formatTokens(m.input),
			formatTokens(m.output),
			formatTokens(m.cacheRead),
			formatTokens(m.cacheWrite),
			costLabel(m.cost, m.unpriced, m.calls),
		];
		const heads = [
			...(split ? ["Harness"] : []),
			"Tokens",
			"Share",
			"In",
			"Out",
			"Cache read",
			"Cache write",
			"Cost (notional)",
		];
		const nameWidth = Math.max(
			...totals.map((m) => visibleWidth(sanitize(m.model)) + 4),
			...providers.map((p) => visibleWidth(sanitize(p.provider)) + 2),
		);
		const widths = [
			heads,
			...totals.map((m) => numbers(m, tokensOf(m), m.harnesses)),
			...providers.map((p) => numbers(p.sub, p.sum, p.via)),
		].reduce<number[]>((acc, cells) => cells.map((cell, c) => Math.max(cell.length, acc[c] ?? 0)), []);
		const tableWidth = 2 + nameWidth + widths.reduce((n, x) => n + x + 2, 0);
		if (tableWidth <= inner) {
			const line = (name: string, cells: readonly string[], paint: (s: string) => string) =>
				`  ${padTo(name, nameWidth)}${cells.map((cell, c) => paint(cell.padStart(nth(widths, c) + 2))).join("")}`;
			rows.push({ lines: [line("", heads, (s) => this.paint("muted", s))], models: [] });
			for (const { provider, models, sub, sum, via } of providers) {
				rows.push({
					lines: [line(`${bullet(provider)} ${t.bold(sanitize(provider))}`, numbers(sub, sum, via), (s) => t.bold(s))],
					models: [],
				});
				for (const m of models)
					rows.push({
						lines: [
							line(
								`${colors.has(m.name) ? `  ${bullet(m.name)} ` : "    "}${sanitize(m.model)}`,
								numbers(m, tokensOf(m), m.harnesses),
								(s) => this.paint("muted", s),
							),
						],
						models: [position++],
					});
			}
			return rows;
		}
		const entry = (m: ModelTotals): string[] => [
			`${bullet(m.name)} ${t.bold(sanitize(m.model))} ${this.paint("muted", `(${percent(tokensOf(m), grand)})${split ? ` · ${m.harnesses.join(",")}` : ""}`)}`,
			this.paint("muted", `  In: ${formatTokens(m.input)} · Out: ${formatTokens(m.output)}`),
			this.paint(
				"muted",
				`  Cache: ${formatTokens(m.cacheRead)} read · ${formatTokens(m.cacheWrite)} write · ${
					m.unpriced > 0 ? costLabel(m.cost, m.unpriced, m.calls) : `${costLabel(m.cost, 0, m.calls)} notional`
				}`,
			),
		];
		for (const { provider, models, sum } of providers) {
			rows.push({
				lines: [
					`${bullet(provider)} ${t.bold(sanitize(provider))}  ${formatTokens(sum)} ${this.paint("muted", `(${percent(sum, grand)})`)}`,
				],
				models: [],
			});
			for (const m of models)
				rows.push({
					lines: entry(m).map((l) => `  ${truncateToWidth(l, Math.max(1, inner - 2), "…")}`),
					models: [position++],
				});
		}
		return rows;
	}
}

/** The item `delta` steps from `current` in `items`, wrapping at both ends. */
function cycle<T>(items: readonly T[], current: T, delta: number): T {
	return nth(items, (items.indexOf(current) + delta + items.length) % items.length);
}

/** `text` padded with spaces to `width` columns (ANSI-aware); never cuts. */
function padTo(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/** `left` and `right` on one `width`-column line, right flush; `undefined` if they would touch. */
function spread(left: string, right: string, width: number): string | undefined {
	const gap = width - visibleWidth(left) - visibleWidth(right);
	return gap >= 3 ? `${left}${" ".repeat(gap)}${right}` : undefined;
}

/** `quota:` section for print output: one line per window, then Claude's missing reading; empty when neither. */
function quotaLines(calls: readonly Call[], quota: readonly QuotaObservation[], now: number): string[] {
	const rows = quotaRows(quota, now);
	const noClaude = claudeHasNoReading(
		quota,
		calls.some((c) => c.harness === "claude"),
	);
	if (rows.length === 0 && !noClaude) return [];
	return [
		"quota:",
		...rows.map(
			(r) => `  ${r.label}: ${r.expired ? "" : `${usedLabel(r.usedPercent)} used, `}${r.reset}, ${r.observed}`,
		),
		...(noClaude ? [`  ${ANTHROPIC}: ${NO_LOCAL_READING}`] : []),
	];
}

/**
 * Plain-text per-model table for print/json/rpc modes, all time, then the harness split and quota readings.
 * Quota stands on its own: readings with no usage still print.
 */
export function summary(calls: readonly Call[], quota: readonly QuotaObservation[] = [], now = Date.now()): string {
	const totals = modelTotals(calls);
	const quotas = quotaLines(calls, quota, now);
	if (totals.length === 0) return ["/stats: no usage recorded yet", ...quotas].join("\n");
	const grand = totals.reduce((n, m) => n + tokensOf(m), 0);
	const harnesses = harnessesOf(calls);
	const split = harnesses.length > 1;
	const head = [
		"provider",
		"model",
		...(split ? ["harness"] : []),
		"in",
		"out",
		"cache read",
		"cache write",
		"cost",
		"%",
	];
	const body = totals.map((m) => [
		sanitize(m.provider),
		sanitize(m.model),
		...(split ? [m.harnesses.join(",")] : []),
		formatTokens(m.input),
		formatTokens(m.output),
		formatTokens(m.cacheRead),
		formatTokens(m.cacheWrite),
		costLabel(m.cost, m.unpriced, m.calls),
		percent(tokensOf(m), grand),
	]);
	const widths = head.map((h, c) => Math.max(h.length, ...body.map((r) => nth(r, c).length)));
	const textual = split ? 3 : 2;
	const fmt = (r: string[]) =>
		r
			.map((cell, c) => (c < textual ? cell.padEnd(nth(widths, c)) : cell.padStart(nth(widths, c))))
			.join("  ")
			.trimEnd();
	const lines = [`/stats: ${formatTokens(grand)} tokens ${TOKENS_NOTE}, all time`, fmt(head), ...body.map(fmt)];
	if (split) {
		lines.push("by harness:");
		for (const h of harnesses) {
			const mine = calls.filter((c) => c.harness === h);
			const sum = mine.reduce((n, c) => n + tokensOf(c), 0);
			const unpriced = mine.filter((c) => c.cost === null).length;
			const cost = mine.reduce((n, c) => n + (c.cost ?? 0), 0);
			lines.push(`  ${h}: ${formatTokens(sum)} (${percent(sum, grand)}), ${costLabel(cost, unpriced, mine.length)}`);
		}
	}
	lines.push(...quotas);
	return lines.join("\n");
}
