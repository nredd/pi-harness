/**
 * The `/stats` overlay: Claude Code's Stats pane rebuilt over pi sessions. Overview has the activity
 * heatmap, headline numbers and the token chart; Models has the chart and the per-model breakdown
 * grouped by provider. `r` cycles the date range, `m` / `M` the provider/model filter.
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
	hourlySeries,
	inRange,
	isHourly,
	type ModelTotals,
	matches,
	modelName,
	modelTotals,
	type Overview,
	overview,
	RANGE_LABEL,
	RANGES,
	type Range,
	rangeStart,
	TOKENS_NOTE,
	tokensOf,
} from "./aggregate.ts";
import { bucketize, GUTTER, plot, TICKS } from "./chart.ts";
import { dayKey, keyDate, shortDate } from "./days.ts";
import { duration, formatTokens, money, percent } from "./format.ts";
import { DAY_LABEL_WIDTH, heatmap, MAX_WEEKS, MONTH_OVERFLOW, weeksFor, YEAR_WEEKS } from "./heatmap.ts";
import type { Call, Session } from "./load.ts";
import { seriesPalette } from "./palette.ts";
import { timeAxis } from "./ticks.ts";

type ThemeLike = Pick<Theme, "fg" | "bg" | "bold" | "style" | "colors">;
export type Tab = "Overview" | "Models" | "Machines";
const TABS: readonly Tab[] = ["Overview", "Models", "Machines"];
/** Chart lines, at most; their colours are shared by the chart, its legend and the model list. */
const SERIES = 3;
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
	tab?: Tab;
}

/** One scroll step of the model list: a provider header, or one or two models side by side. */
/** Per-provider or per-model sums the list shows. */
type Totals = Pick<ModelTotals, "input" | "output" | "cacheRead" | "cacheWrite" | "cost">;

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
			const step = matchesKey(data, Key.shift("tab")) ? -1 : 1;
			this.tab = TABS[(TABS.indexOf(this.tab) + step + TABS.length) % TABS.length] ?? "Overview";
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
		const fg = palette[index];
		return fg ? this.o.theme.style(sanitize(text), { fg }) : this.paint("muted", text);
	}

	private tabsLine(): string {
		const t = this.o.theme;
		const tabs = TABS.map((tab) => (tab === this.tab ? t.bg("selectedBg", t.bold(` ${tab} `)) : ` ${tab} `)).join(" ");
		const bad = this.o.badLines ? `  ${this.paint("warning", `! ${this.o.badLines} unreadable lines`)}` : "";
		return `${t.bold(this.paint("accent", "/stats"))}  ${tabs}${bad}`;
	}

	/** Range choices and the filter on one line, or the filter on its own line when they do not fit. */
	private selectors(inner: number): string[] {
		const t = this.o.theme;
		const ranges = RANGES.map((r) =>
			r === this.range ? t.bold(this.paint("accent", RANGE_LABEL[r])) : this.paint("dim", RANGE_LABEL[r]),
		).join(this.paint("dim", " · "));
		const filter = `${this.paint("muted", "filter:")} ${t.bold(sanitize(filterLabel(this.filter)))}`;
		const line = `${ranges}    ${filter}`;
		return visibleWidth(line) <= inner ? [line] : [ranges, truncateToWidth(filter, inner, "…")];
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
		if (line) lines.push(line);
		return lines.map((l) => truncateToWidth(l, inner, "…"));
	}

	private help(hint = ""): string {
		const keys = this.paint("dim", "tab tabs · r dates · m/M filter · ↑↓ scroll · q close");
		return hint ? `${this.paint("muted", hint)}  ${keys}` : keys;
	}

	private scoped(): { all: Call[]; ranged: Call[] } {
		const all = this.o.calls.filter((c) => matches(this.filter, c) && inRange("all", this.today, c.ms, this.now));
		return { all, ranged: all.filter((c) => inRange(this.range, this.today, c.ms, this.now)) };
	}

	/**
	 * Headline numbers as `label  value` cells, in reading order: favorite model and total tokens,
	 * sessions and longest session, and so on.
	 */
	private statCells(ov: Overview): { label: string; value: string }[] {
		const t = this.o.theme;
		const v = (s: string) => this.paint("accent", s);
		const days = (n: number) => `${t.bold(v(String(n)))} ${n === 1 ? "day" : "days"}`;
		return [
			{ label: "Favorite model", value: t.bold(v(ov.favorite ?? "-")) },
			{ label: "Total tokens", value: `${v(formatTokens(ov.totalTokens))} ${this.paint("muted", TOKENS_NOTE)}` },
			{ label: "Sessions", value: v(String(ov.sessions)) },
			{ label: "Longest session", value: v(duration(ov.longestSessionMs)) },
			{ label: "Active days", value: `${v(String(ov.activeDays))}${this.paint("muted", `/${ov.rangeDays}`)}` },
			{ label: "Longest streak", value: days(ov.longestStreak) },
			{ label: "Most active day", value: v(ov.mostActiveDay ? shortDate(ov.mostActiveDay) : "-") },
			{ label: "Current streak", value: days(ov.currentStreak) },
			{
				label: "Cache tokens",
				value: `${v(formatTokens(ov.cacheRead))} read · ${v(formatTokens(ov.cacheWrite))} write`,
			},
			{ label: "Notional cost", value: v(money(ov.cost)) },
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
						const size = sizes[c];
						const text = `${this.paint("muted", cell.label.padEnd(size?.label ?? 0))}  ${cell.value}`;
						return c < cols - 1 ? padTo(text, (size?.cell ?? 0) + GAP) : text;
					})
					.join(""),
			);
		}
		return out.map((line) => truncateToWidth(line, width, "…"));
	}

	private overviewBody(width: number, room: number): string[] {
		const { all, ranged } = this.scoped();
		const inner = contentWidth(width);
		const out: string[] = [];
		const daily = dailyTotals(all);
		const showHeat = !isHourly(this.range);
		if (ranged.length === 0 && !showHeat) return [this.paint("muted", "No usage in this range.")];
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
				for (let i = 0; i < Math.max(left.length, column.length); i++)
					out.push(`${padTo(left[i] ?? "", area + GAP)}${column[i] ?? ""}`.trimEnd());
			} else {
				out.push(...heat(inner));
				if (cells.length > 0) out.push("", ...this.statGrid(cells, inner, 2));
			}
		} else out.push(...this.statGrid(cells, inner, width >= 130 ? 3 : 2));
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
	 * filter, else one per model; top three. The legend shares the title row when both fit.
	 */
	private chart(
		ranged: readonly Call[],
		width: number,
		height: number,
	): { lines: string[]; colors: Map<string, number> } {
		const t = this.o.theme;
		const inner = contentWidth(width);
		const { by, keys: top } = chartSeries(this.filter, ranged, SERIES);
		const colors = new Map(top.map((k, i): [string, number] => [k.key, i]));
		const hourly = isHourly(this.range);
		const unit = hourly ? "hour" : undefined;
		const title = (name: string) => t.bold(name) + this.paint("muted", `  ${TOKENS_NOTE} · by ${by}`);
		const legend = this.legend(
			top.map((k) => k.key),
			colors,
			inner,
		);
		const head = (name: string): string[] => {
			const row = legend.length === 1 ? spread(title(name), legend[0] ?? "", inner) : undefined;
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
			const series = hourlySeries(
				ranged,
				this.range as "5h" | "24h",
				this.now,
				by === "provider" ? (c) => c.provider : modelName,
			);
			const p = plot(
				top.map((k, i) => ({ values: series.map((s) => s.byKey.get(k.key) ?? 0), color: i })),
				{ width: plotWidth, height, paint },
			);
			const axis = timeAxis(
				series.map((s) => s.ms ?? 0),
				{ kind: "hour" },
				plotWidth,
				p.gutter,
			);
			const out = [...head(`Tokens per ${unit}`), ...p.lines, ...axis.lines.map((l) => this.paint("muted", l))];
			out.push(...this.wrapParts([`From: ${series[0]?.day}`, `To: ${series.at(-1)?.day}`], inner));
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
				...this.wrapParts(
					[`total: peak ${formatTokens(peak)}/hour`, `avg ${formatTokens(avg)}/hour`, "partial edges"],
					inner,
				),
			);
			return { lines: out, colors };
		}
		const from = rangeStart(this.range, this.today) ?? dayKey(ranged[0]?.ms ?? Date.now());
		const series = dailySeries(ranged, from, this.today, by === "provider" ? (c) => c.provider : modelName);
		const byDay = new Map(series.map((p) => [p.day, top.map((k) => p.byKey.get(k.key) ?? 0)]));
		const bucketed = bucketize(from, this.today, (d) => byDay.get(d) ?? [], top.length, plotWidth + 1);
		const out = head(`Tokens per ${bucketed.unit}`);
		if (series.length < 2) {
			out.push(this.paint("muted", "Not enough data for a chart yet"));
			return { lines: out, colors };
		}
		const p = plot(
			top.map((k, i) => ({
				values: bucketed.buckets.map((b) => b.values[i] ?? 0),
				color: colors.get(k.key) ?? i,
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
		let peak = series[0];
		for (const point of series) if (point.total > (peak?.total ?? 0)) peak = point;
		const avg = series.reduce((n, point) => n + point.total, 0) / series.length;
		out.push(
			...this.wrapParts(
				[
					`total: peak ${formatTokens(peak?.total ?? 0)} on ${shortDate(peak?.day ?? this.today)}`,
					`avg ${formatTokens(avg)}/day`,
				],
				inner,
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
		});
		const providers = [...new Set(totals.map((m) => m.provider))].map((provider) => {
			const models = totals.filter((m) => m.provider === provider);
			const sub = sumOf(models);
			return { provider, models, sub, sum: models.reduce((n, m) => n + tokensOf(m), 0) };
		});
		const rows: ListRow[] = [];
		let position = 0;
		const numbers = (m: Totals, sum: number) => [
			formatTokens(sum),
			percent(sum, grand),
			formatTokens(m.input),
			formatTokens(m.output),
			formatTokens(m.cacheRead),
			formatTokens(m.cacheWrite),
			money(m.cost),
		];
		const heads = ["Tokens", "Share", "In", "Out", "Cache read", "Cache write", "Cost (notional)"];
		const nameWidth = Math.max(
			...totals.map((m) => visibleWidth(sanitize(m.model)) + 4),
			...providers.map((p) => visibleWidth(sanitize(p.provider)) + 2),
		);
		const widths = heads.map((h, c) =>
			Math.max(
				h.length,
				...totals.map((m) => (numbers(m, tokensOf(m))[c] ?? "").length),
				...providers.map((p) => (numbers(p.sub, p.sum)[c] ?? "").length),
			),
		);
		const tableWidth = 2 + nameWidth + widths.reduce((n, x) => n + x + 2, 0);
		if (tableWidth <= inner) {
			const line = (name: string, cells: readonly string[], paint: (s: string) => string) =>
				`  ${padTo(name, nameWidth)}${cells.map((cell, c) => paint(cell.padStart((widths[c] ?? 0) + 2))).join("")}`;
			rows.push({ lines: [line("", heads, (s) => this.paint("muted", s))], models: [] });
			for (const { provider, models, sub, sum } of providers) {
				rows.push({
					lines: [line(`${bullet(provider)} ${t.bold(sanitize(provider))}`, numbers(sub, sum), (s) => t.bold(s))],
					models: [],
				});
				for (const m of models)
					rows.push({
						lines: [
							line(
								`${colors.has(m.name) ? `  ${bullet(m.name)} ` : "    "}${sanitize(m.model)}`,
								numbers(m, tokensOf(m)),
								(s) => this.paint("muted", s),
							),
						],
						models: [position++],
					});
			}
			return rows;
		}
		const entry = (m: ModelTotals): string[] => [
			`${bullet(m.name)} ${t.bold(sanitize(m.model))} ${this.paint("muted", `(${percent(tokensOf(m), grand)})`)}`,
			this.paint("muted", `  In: ${formatTokens(m.input)} · Out: ${formatTokens(m.output)}`),
			this.paint(
				"muted",
				`  Cache: ${formatTokens(m.cacheRead)} read · ${formatTokens(m.cacheWrite)} write · ${money(m.cost)} notional`,
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

/** `text` padded with spaces to `width` columns (ANSI-aware); never cuts. */
function padTo(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/** `left` and `right` on one `width`-column line, right flush; `undefined` if they would touch. */
function spread(left: string, right: string, width: number): string | undefined {
	const gap = width - visibleWidth(left) - visibleWidth(right);
	return gap >= 3 ? `${left}${" ".repeat(gap)}${right}` : undefined;
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
