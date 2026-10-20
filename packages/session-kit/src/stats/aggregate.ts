/**
 * Pure aggregation for `/stats`: date ranges, provider/model filters, per-day series and the
 * Overview numbers. "Tokens" is all throughput, input + output + cache read + cache write,
 * everywhere. Anthropic reports almost every prompt token as a cache read or write (its `input` is
 * single digits per call) while Codex reports them as `input`, so anything less badly undercounts
 * agentic usage, and cache reads are what rate limits see.
 */

import { addDays, dayKey, dayRange, daysBetween } from "./days.ts";
import type { Call, Session } from "./load.ts";

export type Range = "all" | "7d" | "30d" | "5h" | "24h";
export const RANGES: readonly Range[] = ["all", "7d", "30d", "5h", "24h"];
export const RANGE_LABEL: Record<Range, string> = { all: "All", "7d": "7d", "30d": "30d", "5h": "5h", "24h": "24h" };
export const HOUR_MS = 3600000;
export const isHourly = (range: Range): range is "5h" | "24h" => range === "5h" || range === "24h";
export const hourlyStart = (range: "5h" | "24h", now: number): number => now - (range === "5h" ? 5 : 24) * HOUR_MS;

/** `{ kind: "all" }`, one provider, or one `provider/model`. */
export type Filter = { kind: "all" } | { kind: "provider"; provider: string } | { kind: "model"; name: string };

export interface ModelTotals {
	/** `provider/model` */
	name: string;
	provider: string;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	calls: number;
}

export interface DayPoint {
	day: string;
	/** Bucket start instant; hourly series only. */
	ms?: number;
	/** Tokens per series key (provider, or `provider/model`). */
	byKey: Map<string, number>;
	total: number;
}

export interface Overview {
	totalTokens: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	favorite?: string;
	sessions: number;
	longestSessionMs: number;
	activeDays: number;
	rangeDays: number;
	mostActiveDay?: string;
	longestStreak: number;
	currentStreak: number;
}

export const tokensOf = (c: Pick<Call, "input" | "output" | "cacheRead" | "cacheWrite">): number =>
	c.input + c.output + c.cacheRead + c.cacheWrite;
/** What `tokensOf` counts, shown next to every token total. */
export const TOKENS_NOTE = "(in + out + cache)";
export const modelName = (c: Pick<Call, "provider" | "model">): string => `${c.provider}/${c.model}`;

export function matches(filter: Filter, c: Pick<Call, "provider" | "model">): boolean {
	if (filter.kind === "all") return true;
	if (filter.kind === "provider") return c.provider === filter.provider;
	return modelName(c) === filter.name;
}

export function filterLabel(filter: Filter): string {
	return filter.kind === "all" ? "All models" : filter.kind === "provider" ? filter.provider : filter.name;
}

/** First day of the range; `undefined` for all time. */
export function rangeStart(range: Range, today: string): string | undefined {
	if (range === "7d") return addDays(today, -6);
	if (range === "30d") return addDays(today, -29);
	return undefined;
}

/** Whether `ms` falls in the range ending today. Days after today (clock skew) are in no range. */
export function inRange(range: Range, today: string, ms: number, now = Date.now()): boolean {
	if (ms > now) return false;
	if (isHourly(range)) return ms >= hourlyStart(range, now);
	const day = dayKey(ms);
	const start = rangeStart(range, today);
	return day <= today && (start === undefined || day >= start);
}

/** All, then providers by tokens, then every model by tokens. */
export function filterCycle(calls: readonly Call[]): Filter[] {
	const byProvider = new Map<string, number>();
	const byModel = new Map<string, number>();
	for (const c of calls) {
		byProvider.set(c.provider, (byProvider.get(c.provider) ?? 0) + tokensOf(c));
		byModel.set(modelName(c), (byModel.get(modelName(c)) ?? 0) + tokensOf(c));
	}
	const desc = (m: Map<string, number>) =>
		[...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
	return [
		{ kind: "all" },
		...desc(byProvider).map((provider): Filter => ({ kind: "provider", provider })),
		...desc(byModel).map((name): Filter => ({ kind: "model", name })),
	];
}

/** Per-model totals, by tokens descending. */
export function modelTotals(calls: readonly Call[]): ModelTotals[] {
	const map = new Map<string, ModelTotals>();
	for (const c of calls) {
		const name = modelName(c);
		let t = map.get(name);
		if (!t) {
			t = {
				name,
				provider: c.provider,
				model: c.model,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				calls: 0,
			};
			map.set(name, t);
		}
		t.input += c.input;
		t.output += c.output;
		t.cacheRead += c.cacheRead;
		t.cacheWrite += c.cacheWrite;
		t.cost += c.cost;
		t.calls++;
	}
	return [...map.values()].sort((a, b) => tokensOf(b) - tokensOf(a) || a.name.localeCompare(b.name));
}

/** One chart line: a provider or a `provider/model`, with its tokens in scope. */
export interface SeriesKey {
	key: string;
	tokens: number;
}

/**
 * What the chart splits by: providers under the "all" filter, models otherwise. Largest first,
 * at most `limit`.
 */
export function chartSeries(
	filter: Filter,
	calls: readonly Call[],
	limit: number,
): { by: "provider" | "model"; keys: SeriesKey[] } {
	const by = filter.kind === "all" ? "provider" : "model";
	const keyOf = by === "provider" ? (c: Call) => c.provider : modelName;
	const sums = new Map<string, number>();
	for (const c of calls) sums.set(keyOf(c), (sums.get(keyOf(c)) ?? 0) + tokensOf(c));
	const keys = [...sums]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, limit)
		.map(([key, tokens]) => ({ key, tokens }));
	return { by, keys };
}

/** Tokens per local day. */
export function dailyTotals(calls: readonly Call[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const c of calls) {
		const day = dayKey(c.ms);
		out.set(day, (out.get(day) ?? 0) + tokensOf(c));
	}
	return out;
}

/** One point per day from `from` to `to` inclusive, zero-filled, split by `keyOf`. */
export function dailySeries(
	calls: readonly Call[],
	from: string,
	to: string,
	keyOf: (c: Call) => string = modelName,
): DayPoint[] {
	const points = dayRange(from, to).map((day): DayPoint => ({ day, byKey: new Map(), total: 0 }));
	const index = new Map(points.map((p, i) => [p.day, i]));
	for (const c of calls) {
		const p = points[index.get(dayKey(c.ms)) ?? -1];
		if (!p) continue;
		const key = keyOf(c);
		p.byKey.set(key, (p.byKey.get(key) ?? 0) + tokensOf(c));
		p.total += tokensOf(c);
	}
	return points;
}

/** Viewer-local labels include UTC offset, distinguishing repeated DST hours. */
export function hourLabel(ms: number): string {
	const date = new Date(ms);
	const offset = -date.getTimezoneOffset();
	const sign = offset >= 0 ? "+" : "-";
	const abs = Math.abs(offset);
	return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")} UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** One-hour UTC buckets; partial first/last buckets, zero-filled, original timestamps only. */
export function hourlySeries(
	calls: readonly Call[],
	range: "5h" | "24h",
	now: number,
	keyOf: (c: Call) => string = modelName,
): DayPoint[] {
	const start = hourlyStart(range, now);
	const from = Math.floor(start / HOUR_MS) * HOUR_MS;
	const to = Math.floor(now / HOUR_MS) * HOUR_MS;
	const points: DayPoint[] = [];
	for (let ms = from; ms <= to; ms += HOUR_MS)
		points.push({
			ms,
			day: `${hourLabel(ms)}${ms < start || ms + HOUR_MS > now ? " (partial)" : ""}`,
			byKey: new Map(),
			total: 0,
		});
	for (const c of calls) {
		if (c.ms < start || c.ms > now) continue;
		const p = points[Math.floor((c.ms - from) / HOUR_MS)];
		if (!p) continue;
		const key = keyOf(c);
		p.byKey.set(key, (p.byKey.get(key) ?? 0) + tokensOf(c));
		p.total += tokensOf(c);
	}
	return points;
}

/** Longest run of consecutive active days, and the run ending today or yesterday. Future days are ignored. */
export function streaks(activeDays: Iterable<string>, today: string): { longest: number; current: number } {
	const days = [...new Set(activeDays)].filter((day) => day <= today).sort();
	let longest = 0;
	let run = 0;
	let prev: string | undefined;
	for (const day of days) {
		run = prev !== undefined && daysBetween(prev, day) === 1 ? run + 1 : 1;
		longest = Math.max(longest, run);
		prev = day;
	}
	const last = days[days.length - 1];
	const current = last !== undefined && daysBetween(last, today) <= 1 ? run : 0;
	return { longest, current };
}

/**
 * Overview numbers for calls already filtered by model and range. `Sessions` and the longest session
 * count only sessions owning one of those calls. Streaks come from `allDays` (the all-time active days
 * under the same model filter), like Claude Code: a streak is not a range stat.
 */
export function overview(
	calls: readonly Call[],
	sessions: readonly Session[],
	range: Range,
	today: string,
	allDays: Iterable<string>,
): Overview {
	const totals = modelTotals(calls);
	const daily = dailyTotals(calls);
	let mostActiveDay: string | undefined;
	let best = -1;
	for (const [day, tokens] of daily) {
		if (tokens > best) {
			best = tokens;
			mostActiveDay = day;
		}
	}
	const start = rangeStart(range, today);
	const firstDay = calls.length > 0 ? dayKey(calls[0]?.ms ?? 0) : today;
	const rangeDays = start === undefined ? daysBetween(firstDay, today) + 1 : daysBetween(start, today) + 1;
	// A session is in scope when it owns at least one call that survived the model and range filters.
	const owners = new Set(calls.map((c) => c.session));
	const inScope = sessions.filter((s) => owners.has(s.path));
	const { longest, current } = streaks(allDays, today);
	return {
		totalTokens: totals.reduce((n, t) => n + tokensOf(t), 0),
		cacheRead: totals.reduce((n, t) => n + t.cacheRead, 0),
		cacheWrite: totals.reduce((n, t) => n + t.cacheWrite, 0),
		cost: totals.reduce((n, t) => n + t.cost, 0),
		favorite: totals[0]?.name,
		sessions: inScope.length,
		longestSessionMs: inScope.reduce((n, s) => Math.max(n, s.endMs - s.startMs), 0),
		activeDays: daily.size,
		rangeDays: Math.max(1, rangeDays),
		mostActiveDay,
		longestStreak: longest,
		currentStreak: current,
	};
}
