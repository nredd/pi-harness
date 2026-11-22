/**
 * Quota row for the expanded footer.
 *
 * Pure helpers plus a poller for the subscription router's `router:rpc:usage`
 * event RPC. No pi imports, so it can be unit tested without starting pi.
 * The poller sends `{ refresh: true }`, so the router may do a cache-aware
 * refresh of its usage endpoints; this module itself never does network I/O.
 * Rendering only reads the last stored state and never waits on a request.
 */

import { randomUUID } from "node:crypto";

export const USAGE_CHANNEL = "router:rpc:usage";
export const POLL_INTERVAL_MS = 60_000;
export const REPLY_TIMEOUT_MS = 12_000;
export const WARNING_AT = 20;
export const ERROR_AT = 5;

const WEEK_MS = 604_800_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

// Only the v1 adapter supplies these defaults. V2 display and selectors come from the view.
const LEGACY_DISPLAY = {
	anthropic: {
		full: "Anthropic",
		compact: "Anth",
		footer: { show: [{ name: "five_hour" }, { name: "seven_day" }], placeholder: true },
	},
	"openai-codex": {
		full: "OpenAI",
		compact: "OAI",
		footer: { show: [{ durationMs: WEEK_MS }], placeholder: true },
	},
};

type Selector = { name: string } | { durationMs: number };
interface Display {
	full: string;
	compact: string;
	footer?: { show?: Selector[]; placeholder: boolean };
}

type Unit = keyof typeof UNITS;
const UNITS = {
	requests: ["req", "requests"],
	tokens: ["tok", "tokens"],
	usd: ["USD", "USD"],
	credits: ["credits", "credits"],
} as const;

/** A span the provider did not state: `assumed` (or unrecognized) is unknown, `inferred` is estimated. */
type SpanQualifier = "assumed" | "inferred";

interface WindowLabel {
	name: string;
	durationMs: number | undefined;
	calendar: boolean;
	/** Absent when the span is reported, or predates span provenance. */
	span?: SpanQualifier;
}

interface PercentCell extends WindowLabel {
	kind: "percent";
	key: string;
	families: string[];
	remaining: number | undefined;
	resetAt: number | undefined;
	unidentified: boolean;
	placeholder: boolean;
}

type Cell =
	| PercentCell
	| (WindowLabel & {
			kind: "count";
			amount: number;
			left: boolean;
			limit?: number;
			resetAt: number | undefined;
			unit: Unit;
			basis: "reported" | "observed" | "inferred";
			families: string[];
	  })
	| {
			kind: "mark";
			/** Full family ids, for matching. */
			families: string[];
			/** Bounded display labels for the first `FAMILIES_MAX` families; `extra` counts the rest. */
			names: string[];
			extra: number;
			until: number;
			evidence: "read" | "inferred" | "observed" | "unknown";
	  }
	| { kind: "pool"; name: string; balance?: number; unlimited: boolean; unit: Unit }
	/** A view whose snapshot failed with nothing else to show: the failure is the reading. */
	| { kind: "status"; status: "error" | "unavailable" | "stale" };

/** Recursively readonly: state is shared between the poller and every render. */
type Frozen<T> = T extends object ? { readonly [K in keyof T]: Frozen<T[K]> } : T;

interface QuotaFields {
	display: Display;
	cells: QuotaCell[];
	stale: boolean;
	expiresAt?: number;
	/** Rendered with the legacy Anthropic/Codex rules, which keep those rows byte-identical. */
	legacy: boolean;
}

export type ProviderQuota = Frozen<QuotaFields>;
export type QuotaState = Frozen<Record<string, QuotaFields>>;
type QuotaCell = Frozen<Cell>;

/** Freeze a freshly built value in place, objects and arrays included. */
function deepFreeze<T>(value: T): Frozen<T> {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value as Frozen<T>;
}

/** Remaining percent from a used percent: clamp 0..100, floor remaining; invalid -> `undefined`. */
export function remainingPercent(used: unknown): number | undefined {
	const value = finite(used);
	return value === undefined ? undefined : Math.floor(100 - Math.min(100, Math.max(0, value)));
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function epoch(value: unknown): number | undefined {
	const n = finite(value);
	return n !== undefined && n > 0 && n <= 8.64e15 ? n : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.map(asRecord).filter((record) => record !== undefined) : [];
}

/** Keep quota text single-line, ASCII and free of terminal controls, including from plug-ins. */
function textOf(value: unknown): string | undefined {
	return typeof value === "string" ? value.replace(/[^ -~]/g, "?").trim() || undefined : undefined;
}

/** Longest provider, bucket, pool or family label shown; longer text ends in `...`. Matching uses the full id. */
export const LABEL_MAX = 48;
/** Most families a mark names; the rest are counted as `+N`. */
export const FAMILIES_MAX = 4;

/** Display text bounded to `LABEL_MAX`, so layout never builds or measures an unbounded label. */
function labelOf(value: unknown): string | undefined {
	const text = textOf(value);
	return text && text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 3)}...` : text;
}

function familiesOf(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
}

function readDisplay(raw: unknown, id: string): Display {
	const display = asRecord(raw);
	const footer = asRecord(display?.footer);
	const show = Array.isArray(footer?.show)
		? records(footer.show).flatMap<Selector>((item) => {
				if (typeof item.name === "string") return [{ name: item.name }];
				const durationMs = finite(item.durationMs);
				return durationMs === undefined ? [] : [{ durationMs }];
			})
		: undefined;
	return {
		full: labelOf(display?.full) ?? id,
		compact: labelOf(display?.compact) ?? id,
		footer: { show, placeholder: footer?.placeholder === true },
	};
}

/** Default only an absent span; an unrecognized one is unknown, never promoted to reported. */
function spanOf(raw: Record<string, unknown>): SpanQualifier | undefined {
	if (raw.spanSource === undefined || raw.spanSource === "reported") return undefined;
	return raw.spanSource === "inferred" ? "inferred" : "assumed";
}

function windowLabel(raw: Record<string, unknown>, name: string): WindowLabel {
	const span = spanOf(raw);
	return {
		name,
		durationMs: finite(raw.durationMs),
		calendar: raw.kind === "calendar" && asRecord(raw.resetRule)?.every === "day",
		...(span && { span }),
	};
}

function buckets(windows: unknown): { raw: Record<string, unknown>; label: WindowLabel; families: string[] }[] {
	return records(windows).flatMap((raw) => {
		const name = labelOf(raw.name);
		if (!name || (raw.scope !== "model" && raw.scope !== "provider")) return [];
		const families = raw.scope === "model" ? familiesOf(raw.families) : [];
		return raw.scope === "model" && families.length === 0 ? [] : [{ raw, label: windowLabel(raw, name), families }];
	});
}

function selectorLabel(selector: Selector): WindowLabel {
	if (!("name" in selector)) return { name: "quota", durationMs: selector.durationMs, calendar: false };
	const durationMs = selector.name === "five_hour" ? 5 * HOUR_MS : selector.name === "seven_day" ? WEEK_MS : undefined;
	return { name: labelOf(selector.name) ?? "quota", durationMs, calendar: false };
}

function chooseWindows(raw: unknown, display: Display, legacy: boolean): PercentCell[] {
	const windows = buckets(raw).filter(
		({ raw, families }) => (raw.basis === undefined || raw.basis === "reported") && (!legacy || families.length === 0),
	);
	const reading = (
		{ raw, label, families }: (typeof windows)[number],
		key: string,
		override?: WindowLabel,
	): PercentCell => ({
		...label,
		...override,
		// Only legacy rows name an unknown span `quota`; generic rows keep the bucket's own name.
		...(legacy && label.span === "assumed" && { name: "quota" }),
		kind: "percent",
		key,
		families,
		remaining: remainingPercent(raw.usedPercent),
		resetAt: epoch(raw.resetAt),
		unidentified: label.span === "assumed",
		placeholder: false,
	});
	const show = display.footer?.show;
	// Keys use the full name: two long names sharing a bounded label stay distinct readings.
	if (!show) return windows.map((window) => reading(window, JSON.stringify([window.raw.name, window.families])));
	return show.flatMap((selector, i) => {
		const chosenLabel = selectorLabel(selector);
		const key = JSON.stringify(selector);
		let matches = windows.filter(({ raw }) =>
			"name" in selector
				? raw.name === selector.name
				: raw.spanSource === undefined && (legacy || raw.durationMs === undefined)
					? // A snapshot without span provenance predates spans: its `7d` bucket is the weekly one.
						raw.name === "7d" && (legacy || selector.durationMs === WEEK_MS)
					: !spanOf(raw) && raw.durationMs === selector.durationMs,
		);
		if (legacy) matches = "name" in selector ? matches.slice(-1) : matches.slice(0, 1);
		const matched = matches.length > 0;
		if (!matched && "durationMs" in selector) {
			// An assumed or inferred span cannot satisfy a selector, but the most limiting reading is still useful.
			const assumed = windows.filter(({ label }) => label.span !== undefined);
			assumed.sort(
				(a, b) => (remainingPercent(a.raw.usedPercent) ?? 101) - (remainingPercent(b.raw.usedPercent) ?? 101),
			);
			matches = assumed.slice(0, 1);
		}
		if (matches.length)
			return matches.map((window) =>
				reading(
					window,
					JSON.stringify([key, window.families]),
					// A fallback reading keeps its own span: a selector never lends it a duration.
					legacy || (matched && window.label.durationMs === undefined) ? chosenLabel : undefined,
				),
			);
		return display.footer?.placeholder && i === show.length - 1
			? [
					{
						...chosenLabel,
						kind: "percent" as const,
						key: JSON.stringify([key, []]),
						families: [],
						remaining: undefined,
						resetAt: undefined,
						unidentified: false,
						placeholder: true,
					},
				]
			: [];
	});
}

function unitOf(value: unknown): Unit | undefined {
	return typeof value === "string" && Object.hasOwn(UNITS, value) ? (value as Unit) : undefined;
}

function auxiliaryCells(view: Record<string, unknown>, legacy: boolean): Cell[] {
	const counts = buckets(view.meters).flatMap<Cell>(({ raw, label, families }) => {
		const quantity = asRecord(raw.quantity);
		const unit = unitOf(quantity?.unit);
		const used = finite(quantity?.used);
		const amount = used ?? finite(quantity?.remaining);
		// Absent means reported; an unrecognized basis is skipped rather than promoted.
		const basis = raw.basis === undefined ? "reported" : raw.basis;
		if (basis !== "reported" && basis !== "observed" && basis !== "inferred") return [];
		// Zero observed calls do not create a quota row on their own; a reported or inferred zero is a reading.
		if (!unit || amount === undefined || (used === 0 && basis === "observed")) return [];
		return [
			{
				...label,
				kind: "count",
				families,
				amount,
				left: used === undefined,
				unit,
				limit: finite(quantity?.limit),
				resetAt: epoch(raw.resetAt),
				basis,
			},
		];
	});
	const pools = records(view.pools).flatMap<Cell>((pool) => {
		const name = labelOf(pool.name);
		const unit = unitOf(pool.unit);
		const balance = finite(pool.balance);
		return name && unit ? [{ kind: "pool", name, unit, balance, unlimited: pool.unlimited === true }] : [];
	});
	const marks = records(view.marks).flatMap<Cell>((mark) => {
		const until = epoch(mark.until);
		// Absent means read. An unrecognized value stays visible as unknown: a block is never hidden.
		const evidence =
			mark.evidence === undefined
				? "read"
				: mark.evidence === "read" || mark.evidence === "observed" || mark.evidence === "inferred"
					? mark.evidence
					: "unknown";
		// Legacy reported rows already summarize collected quota. Do not add legacy read marks to them.
		const families = familiesOf(mark.families);
		const names = families.slice(0, FAMILIES_MAX).map((id) => labelOf(id) ?? "model");
		return until !== undefined && !(legacy && evidence === "read")
			? [{ kind: "mark", families, names, extra: families.length - names.length, until, evidence }]
			: [];
	});
	return [...counts, ...pools, ...marks];
}

/** Merge stale percentages by bucket, retaining their reset and identity as one reading. */
function mergePercents(seen: PercentCell[], prior: ProviderQuota | undefined, legacy: boolean): Frozen<PercentCell>[] {
	const before = prior?.cells.filter((cell) => cell.kind === "percent") ?? [];
	const readings = new Map<string, Frozen<PercentCell>>(before.map((cell) => [cell.key, cell]));
	for (const cell of seen) {
		const old = readings.get(cell.key);
		if (!old && (!legacy || prior?.expiresAt === undefined || cell.placeholder)) readings.set(cell.key, cell);
		if (
			old &&
			cell.remaining !== undefined &&
			!(cell.unidentified && !old.unidentified && old.remaining !== undefined)
		) {
			readings.set(cell.key, cell);
		}
	}
	return [...readings.values()].sort((a, b) =>
		legacy ? Number(b.durationMs === 5 * HOUR_MS) - Number(a.durationMs === 5 * HOUR_MS) : 0,
	);
}

/** Normalize legacy snapshots or v2 views at the event boundary, without depending on router code. */
export function parseUsageReply(reply: unknown, now: number, previous?: QuotaState): QuotaState | undefined {
	const envelope = asRecord(reply);
	if (envelope?.success !== true) return undefined;
	const data = asRecord(envelope.data);
	const views = data?.views;
	const snapshots = data?.snapshots;
	if (!Array.isArray(views) && !Array.isArray(snapshots)) return undefined;
	const entries = Array.isArray(views)
		? records(views)
		: Object.entries(LEGACY_DISPLAY).map(([provider, display]) => ({
				provider,
				display,
				snapshot: records(snapshots).find((snapshot) => snapshot.provider === provider),
			}));
	const state: Record<string, QuotaFields> = Object.create(null);
	for (const view of entries) {
		if (typeof view.provider !== "string" || !view.provider) continue;
		const id = view.provider;
		const prior = previous && Object.hasOwn(previous, id) ? previous[id] : undefined;
		const display = readDisplay(view.display, labelOf(id) ?? "quota");
		// Legacy quirks belong to the legacy footer selection (v1, or a v2 view that keeps it), not to the id.
		const legacy =
			Object.hasOwn(LEGACY_DISPLAY, id) &&
			JSON.stringify(display.footer) === JSON.stringify(LEGACY_DISPLAY[id as keyof typeof LEGACY_DISPLAY].footer);
		const snapshot = asRecord(view.snapshot);
		const expiresAt = epoch(snapshot?.expiresAt);
		const windows = snapshot?.windows;
		// Freshness covers meters and pools too, so only legacy rows need a percentage window.
		const fresh =
			snapshot?.status === "available" &&
			Array.isArray(windows) &&
			(windows.length > 0 || !legacy) &&
			expiresAt !== undefined &&
			expiresAt > now;
		const seen = chooseWindows(windows, display, legacy);
		const cells: QuotaCell[] = [
			...(fresh ? seen : mergePercents(seen, prior, legacy)),
			...auxiliaryCells(view, legacy),
		];
		const status = snapshot?.status;
		if (
			(status === "error" || status === "unavailable" || status === "stale") &&
			!cells.some((cell) => cell.kind !== "mark")
		) {
			cells.unshift({ kind: "status", status });
		}
		state[id] = { display, legacy, stale: !fresh, expiresAt: fresh ? expiresAt : prior?.expiresAt, cells };
	}
	return deepFreeze(state);
}

/** Mark every provider stale, retaining values (error, timeout). */
export function markStale(state: QuotaState): QuotaState {
	return deepFreeze(Object.fromEntries(Object.entries(state).map(([id, quota]) => [id, { ...quota, stale: true }])));
}

/** Whether a provider reading is stale at `now`: flagged, or expiry missing, invalid or passed. */
export function isStale(quota: ProviderQuota, now: number): boolean {
	return (
		quota.stale || typeof quota.expiresAt !== "number" || !Number.isFinite(quota.expiresAt) || quota.expiresAt <= now
	);
}

/** Copy of `state` with effective staleness at `now`; cached figures are kept. */
export function effectiveState(state: QuotaState, now: number): QuotaState {
	return deepFreeze(
		Object.fromEntries(Object.entries(state).map(([id, quota]) => [id, { ...quota, stale: isStale(quota, now) }])),
	);
}

export type Tier = "full" | "compact";
/** Subset of the pi theme used here. */
export type Colorize = (color: "warning" | "error" | "dim", text: string) => string;

function formatValue(remaining: number | undefined, colorize: Colorize): string {
	if (remaining === undefined) return "--";
	const text = `${remaining}%`;
	if (remaining <= ERROR_AT) return colorize("error", text);
	if (remaining <= WARNING_AT) return colorize("warning", text);
	return text;
}

/** Clock and zone for reset labels; both injectable so tests need no real time or TZ. */
export interface FormatOptions {
	/** Epoch ms treated as the present. Default `Date.now()`. */
	now?: number;
	/** Physical model whose model-scoped buckets are relevant, if resolved. */
	model?: { provider: string; id: string };
	/** IANA zone for reset labels. Default: the process-local zone, like the router's own `toLocaleTimeString()`. */
	timeZone?: string;
}

function zoneParts(epoch: number, timeZone: string | undefined): Record<string, string> {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(epoch);
	return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

/**
 * Local 24h reset label: `HH:MM` when the reset is on the same calendar day as `now`
 * (and `alwaysDate` is false), else `Mon D HH:MM`. Calendar days and DST follow `timeZone`.
 */
export function formatResetAt(resetAt: number, now: number, timeZone?: string, alwaysDate = false): string {
	const at = zoneParts(resetAt, timeZone);
	const time = `${at.hour}:${at.minute}`;
	const today = zoneParts(now, timeZone);
	const sameDay = at.year === today.year && at.month === today.month && at.day === today.day;
	return sameDay && !alwaysDate ? time : `${at.month} ${at.day} ${time}`;
}

/** Row layout: label tier, whether reset times are shown, and one row per provider instead of one row. */
interface Layout {
	tier: Tier;
	resets: boolean;
	split: boolean;
	essential?: boolean;
	/** Fallback only: at most `rows` provider rows, then a `+N more` pointer within `width`. */
	cap?: { rows: number; width: number };
	/** Generic fallback only: rank cells by priority and budget each row against this width. */
	budget?: number;
	/** Name a mark's scope generically, so its evidence survives a narrow row. */
	terse?: boolean;
}

function windowText(
	label: string,
	remaining: number | undefined,
	resetAt: number | undefined,
	weekly: boolean,
	layout: Layout,
	colorize: Colorize,
	opts: Required<Pick<FormatOptions, "now">> & FormatOptions,
	span: SpanQualifier | undefined,
): string {
	const dim = (text: string) => colorize("dim", text);
	const value = formatValue(remaining, colorize);
	// Percent and freshness are never altered by the reset; a missing or already-past reset is just not shown.
	const when =
		layout.resets && resetAt !== undefined && resetAt > opts.now
			? formatResetAt(resetAt, opts.now, opts.timeZone, weekly)
			: undefined;
	const full = layout.tier === "full";
	const name = full ? label : `${label}${qualifierMark(span)}`;
	// An unstated span says so in the full tier; compact carries it as `?` (unknown) or `~` (inferred).
	const note = full ? spanNote(span) : undefined;
	const parts = full ? [when ? `resets ${when}` : undefined, note].filter(Boolean).join("; ") : "";
	const suffix = full ? (parts ? ` (${parts})` : "") : when ? ` @${when}` : "";
	return `${dim(`${name} `)}${value}${dim(suffix)}`;
}

function qualifierMark(span: SpanQualifier | undefined): string {
	return span === "assumed" ? "?" : span === "inferred" ? "~" : "";
}

function spanNote(span: SpanQualifier | undefined): string | undefined {
	return span === "assumed" ? "window unknown" : span === "inferred" ? "span inferred" : undefined;
}

function labels(cell: WindowLabel): [string, string] {
	const span = cell.durationMs;
	if (cell.calendar || span === DAY_MS) return ["day", "1d"];
	if (span === WEEK_MS) return ["weekly", "7d"];
	if (span === undefined || span < MINUTE_MS) return [cell.name, cell.name];
	const label = span % HOUR_MS === 0 ? `${span / HOUR_MS}h` : `${span / MINUTE_MS}m`;
	return [label, label];
}

const BOUNDARY = "-./:";

/** Case-insensitive token match: `family` sits between id edges or `-./:`. No regex, so any input is total. */
function matchesModel(id: string, family: string): boolean {
	const haystack = id.toLowerCase();
	const needle = family.toLowerCase();
	for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
		const before = at === 0 || BOUNDARY.includes(haystack.charAt(at - 1));
		const end = at + needle.length;
		if (before && (end === haystack.length || BOUNDARY.includes(haystack.charAt(end)))) return true;
	}
	return false;
}

function activeCells(id: string, quota: ProviderQuota, opts: ResolvedOptions): QuotaCell[] {
	const models = quota.cells.flatMap((cell) => (cell.kind === "mark" && cell.until > opts.now ? cell.families : []));
	if (opts.model?.provider === id) models.push(opts.model.id);
	return quota.cells.filter((cell) => {
		if (cell.kind === "mark") return cell.until > opts.now;
		if (cell.kind === "pool" || cell.kind === "status") return true;
		return !cell.families.length || cell.families.some((family) => models.some((model) => matchesModel(model, family)));
	});
}

type ResolvedOptions = FormatOptions & { now: number };

function quantityText(value: number, unit: Unit): string {
	return unit === "usd" ? `$${value.toFixed(2)}` : String(value);
}

function countText(cell: Extract<QuotaCell, { kind: "count" }>, full: boolean, when: string | undefined): string {
	const basis = full ? cell.basis : { reported: "rep", observed: "obs", inferred: "inf" }[cell.basis];
	const amount = quantityText(cell.amount, cell.unit);
	const total = cell.limit === undefined ? amount : `${amount}/${quantityText(cell.limit, cell.unit)}`;
	// An unknown span is named, not converted to a duration.
	const [long, short] = cell.span === "assumed" ? [cell.name, cell.name] : labels(cell);
	const mark = qualifierMark(cell.span);
	const parts = [when && `resets ${when}`, spanNote(cell.span)].filter(Boolean).join("; ");
	const note = full ? (parts ? ` (${parts})` : "") : when ? ` @${when}` : "";
	const tail = cell.left ? " left" : "";
	if (cell.unit === "usd" && cell.durationMs !== undefined && !cell.calendar && cell.span !== "assumed") {
		return full ? `${total}${tail} last ${long} ${basis}${note}` : `${total}${tail}/${short}${mark} ${basis}${note}`;
	}
	const unit = cell.unit === "usd" ? "" : ` ${UNITS[cell.unit][full ? 1 : 0]}`;
	return `${full ? long : `${short}${mark}`} ${total}${unit}${tail} ${basis}${note}`;
}

function cellText(cell: QuotaCell, layout: Layout, colorize: Colorize, opts: ResolvedOptions): string {
	const full = layout.tier === "full";
	switch (cell.kind) {
		case "percent": {
			// An unknown span is named, not converted to a duration.
			const label = cell.unidentified ? cell.name : labels(cell)[full ? 0 : 1];
			return windowText(
				label,
				cell.remaining,
				cell.resetAt,
				cell.unidentified || cell.durationMs === WEEK_MS,
				layout,
				colorize,
				opts,
				cell.span,
			);
		}
		case "count": {
			// Like windows: a missing or already-past reset is just not shown.
			const when =
				layout.resets && cell.resetAt !== undefined && cell.resetAt > opts.now
					? formatResetAt(cell.resetAt, opts.now, opts.timeZone)
					: undefined;
			return colorize("dim", countText(cell, full, when));
		}
		case "pool": {
			const balance = cell.unlimited
				? "unlimited"
				: cell.balance === undefined
					? "--"
					: quantityText(cell.balance, cell.unit);
			return colorize(
				"dim",
				`${cell.name} ${balance}${cell.unit === "usd" ? "" : ` ${UNITS[cell.unit][full ? 1 : 0]}`}`,
			);
		}
		case "status":
			return colorize("dim", `quota ${cell.status}`);
		case "mark": {
			const families = cell.names;
			const named = (full ? families : families.map((id) => id.replace(/^[a-z]+-\d+-/, ""))).join(",");
			const scope = `${named}${cell.extra ? `+${cell.extra}` : ""}` || "provider";
			const when = layout.resets ? formatResetAt(cell.until, opts.now, opts.timeZone, full) : undefined;
			const evidence = full
				? `(${cell.evidence})`
				: { inferred: "inf", observed: "obs", read: "read", unknown: "unk" }[cell.evidence];
			// Terse keeps the scope kind honest: a model-scoped block never reads as the whole provider.
			const subject = layout.terse ? (families.length ? "model " : "") : `${scope} `;
			return colorize(
				"warning",
				`${subject}blocked${when ? (full ? ` until ${when}` : `->${when.split(" ").at(-1)}`) : ""} ${evidence}`,
			);
		}
	}
}

function isEssential(cell: QuotaCell): cell is Extract<QuotaCell, { kind: "mark" | "percent" | "status" }> {
	return cell.kind === "mark" || cell.kind === "percent" || cell.kind === "status";
}

function priority(cell: QuotaCell): number {
	if (cell.kind === "mark" || cell.kind === "status") return -1;
	return cell.kind === "percent" ? (cell.remaining ?? 101) : 102;
}

/** Lowest remaining percentage among `cells`, 101 when none is known. One pass: never spread an unbounded array. */
function lowestRemaining(cells: readonly QuotaCell[]): number {
	let lowest = 101;
	for (const cell of cells) {
		if (cell.kind === "percent" && cell.remaining !== undefined && cell.remaining < lowest) lowest = cell.remaining;
	}
	return lowest;
}

interface Segment {
	quota: ProviderQuota;
	cells: QuotaCell[];
}

function providerRows(segments: Segment[], layout: Layout, colorize: Colorize, opts: ResolvedOptions): string[] {
	const full = layout.tier === "full";
	const dim = (text: string) => colorize("dim", text);
	const rendered = segments.flatMap(({ quota, cells }) => {
		const shown = layout.essential ? cells.filter(isEssential) : cells;
		if (!shown.length) return [];
		const marks = shown.filter((cell) => cell.kind === "mark");
		const data = shown.filter((cell) => cell.kind !== "mark");
		// Staleness qualifies cached readings only. Marks carry their own expiry, so never read as stale.
		// Generic rows also age at the render clock; legacy rows keep their parsed flag byte for byte.
		const expired = quota.stale || (!quota.legacy && isStale(quota, opts.now));
		const stale = expired && data.some((cell) => cell.kind !== "status");
		const groupText = (group: QuotaCell[]) =>
			group
				.map((cell) => cellText(cell, layout, colorize, opts))
				.join(full && group.every((cell) => cell.kind !== "percent") ? dim("; ") : " ");
		const name = full ? quota.display.full : quota.display.compact;
		const budget = layout.budget;
		if (budget !== undefined) {
			const ranked = data.sort((a, b) => priority(a) - priority(b));
			// Marks lead; stale data follows them behind its own label.
			const pieces = [...marks, ...ranked].map((cell, i) => ({
				cell,
				sep: stale && marks.length && i === marks.length ? " | (stale) " : " ",
			}));
			const suffix = stale && !marks.length ? " (stale)" : "";
			return [{ shown, make: (lead: string) => budgetRow(lead, name, suffix, pieces, budget, layout, colorize, opts) }];
		}
		const ordered = [data, marks]
			.filter((group) => group.length)
			.map(groupText)
			.join(dim(full ? "; " : " | "));
		const text = dim(`${name}${stale ? " (stale)" : ""} `) + ordered;
		return [{ shown, make: (lead: string) => dim(lead) + text }];
	});
	if (!rendered.length) return [];
	const lead = full ? "Quota left: " : "Left: ";
	if (!layout.split) return [dim(lead) + rendered.map(({ make }) => make("")).join(dim(" | "))];
	const blocked = ({ shown }: (typeof rendered)[number]) => shown.some((cell) => cell.kind === "mark");
	const draw = (rows: typeof rendered) => rows.map(({ make }, i) => make(i === 0 ? lead : ""));
	const cap = layout.cap;
	if (!cap || rendered.length <= cap.rows) return draw(rendered);
	// Before capping, rank blocked providers first, then the lowest remaining quota within each group,
	// so a cap never hides a block silently and keeps the most constrained blocked provider.
	const ranked = rendered
		.map((row) => ({ row, blocked: blocked(row), lowest: lowestRemaining(row.shown) }))
		.sort((a, b) => Number(b.blocked) - Number(a.blocked) || a.lowest - b.lowest)
		.map(({ row }) => row);
	const hidden = ranked.slice(cap.rows).filter(blocked).length;
	return [...draw(ranked.slice(0, cap.rows)), dim(overflowPointer(ranked.length - cap.rows, hidden, cap.width))];
}

/**
 * The `+N more` pointer, always within `width`. The hidden blocked count outranks everything else:
 * `+N more (K blocked): /router status`, `+N more (K blocked)`, `+K!`, `!`; without hidden blocks
 * `+N more: /router status`, `+N more`, `+N`, `+`; nothing when even one character does not fit.
 */
export function overflowPointer(more: number, blocked: number, width: number): string {
	const count = `+${more} more${blocked ? ` (${blocked} blocked)` : ""}`;
	const ladder = [`${count}: /router status`, count, ...(blocked ? [`+${blocked}!`, "!"] : [`+${more}`, "+"])];
	return ladder.find((text) => text.length <= width) ?? "";
}

const PLAIN: Colorize = (_color, text) => text;
const MORE = " ...";

/** Shorten a provider label to `room` characters, marking the cut when there is space for it. */
function shorten(name: string, room: number): string {
	if (name.length <= room) return name;
	return room > 3 ? `${name.slice(0, room - 3)}...` : name.slice(0, room);
}

type Piece = { cell: QuotaCell; sep: string; layout: Layout };

/**
 * One prioritized row within `width`: the label yields first, so the highest-priority cell
 * (a mark, then the lowest quota) always survives whole, with its scope and evidence together.
 * A mark that cannot fit even tersely is omitted rather than clipped mid-assertion; whole lower
 * cells are dropped behind a ` ...` marker.
 */
function budgetRow(
	lead: string,
	name: string,
	suffix: string,
	pieces: { cell: QuotaCell; sep: string }[],
	width: number,
	layout: Layout,
	colorize: Colorize,
	opts: ResolvedOptions,
): string {
	const dim = (text: string) => colorize("dim", text);
	const draw = (label: string, chosen: Piece[], more: boolean) =>
		dim(`${lead}${label}${chosen.length ? suffix : ""}`) +
		chosen.map((piece) => dim(piece.sep) + cellText(piece.cell, piece.layout, colorize, opts)).join("") +
		(more ? dim(MORE) : "");
	const all: Piece[] = pieces.map((piece) => ({ ...piece, layout }));
	const size = (piece: Piece) => piece.sep.length + cellText(piece.cell, piece.layout, PLAIN, opts).length;
	const [first, ...rest] = all as [Piece, ...Piece[]];
	const heads = first.cell.kind === "mark" ? [first, { ...first, layout: { ...layout, terse: true } }] : [first];
	for (const head of heads) {
		const room = width - lead.length - suffix.length - size(head);
		if (room < 1) continue;
		const label = shorten(name, room);
		const chosen = [head];
		let used = lead.length + label.length + suffix.length + size(head);
		for (const piece of rest) {
			if (used + size(piece) > width) break;
			chosen.push(piece);
			used += size(piece);
		}
		const dropped = chosen.length < all.length;
		while (dropped && chosen.length > 1 && used + MORE.length > width) used -= size(chosen.pop() as Piece);
		return draw(label, chosen, dropped && used + MORE.length <= width);
	}
	// Nothing fits beside even a one-character label: show what fits of the provider, assert nothing.
	const label = shorten(name, Math.max(0, width - lead.length));
	return dim(`${lead}${label}`.slice(0, Math.max(0, width)));
}

function segmentsOf(state: QuotaState, opts: ResolvedOptions): Segment[] {
	return Object.entries(state).flatMap(([id, quota]) => {
		const cells = activeCells(id, quota, opts);
		return cells.length ? [{ quota, cells }] : [];
	});
}

/** Single-row rendering for one label tier. */
export function formatQuotaRow(state: QuotaState, tier: Tier, colorize: Colorize, opts: FormatOptions = {}): string {
	const resolved = { ...opts, now: opts.now ?? Date.now() };
	return providerRows(segmentsOf(state, resolved), { tier, resets: true, split: false }, colorize, resolved).join("\n");
}

const NO_RESETS: Layout = { tier: "compact", resets: false, split: true };
const ESSENTIAL: Layout = { ...NO_RESETS, essential: true };
const LAYOUTS: readonly Layout[] = [
	{ tier: "full", resets: true, split: false },
	{ tier: "compact", resets: true, split: false },
	{ tier: "compact", resets: true, split: true },
	NO_RESETS,
	ESSENTIAL,
];

/** Choose the widest layout that fits before coloring. The TUI clips only as a last resort. */
export function fitQuotaRows(state: QuotaState, width: number, colorize: Colorize, opts: FormatOptions = {}): string[] {
	const plain: Colorize = (_color, text) => text;
	const resolved = { ...opts, now: opts.now ?? Date.now() };
	const segments = segmentsOf(state, resolved);
	if (!segments.length) return [];
	const hasEssential = segments.some(({ cells }) => cells.some(isEssential));
	for (const layout of LAYOUTS) {
		if (layout.essential && !hasEssential) continue;
		const rows = providerRows(segments, layout, plain, resolved);
		if ((!layout.split || rows.length <= 4) && rows.every((row) => row.length <= width)) {
			return providerRows(segments, layout, colorize, resolved);
		}
	}
	const allLegacy = Object.values(state).every((quota) => quota.legacy);
	// Never erase the footer altogether when only meters or pools are available.
	const fallback = hasEssential ? ESSENTIAL : NO_RESETS;
	// Legacy rows keep their pinned bytes; generic rows are budgeted so the caller's clip never cuts a cell.
	const layout = { ...fallback, cap: { rows: 4, width }, ...(allLegacy ? {} : { budget: width }) };
	return providerRows(segments, layout, colorize, resolved);
}

/** Minimal event bus (matches `pi.events`). */
export interface EventBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
	emit(channel: string, data: unknown): void;
}

export interface PollerDeps {
	events: EventBus;
	/** Called after state changes so the caller can re-render. */
	onChange: () => void;
	now?: () => number;
	newId?: () => string;
	setTimeout?: (fn: () => void, ms: number) => unknown;
	clearTimeout?: (handle: unknown) => void;
	setInterval?: (fn: () => void, ms: number) => unknown;
	clearInterval?: (handle: unknown) => void;
}

export interface QuotaPoller {
	/** Latest state with effective staleness at the current time, or `undefined` before the first valid reply. */
	getState(): QuotaState | undefined;
	/** Send the first request and begin the 60s cadence. */
	start(): void;
	/** Cancel timers and listeners; later replies are ignored. */
	dispose(): void;
}

const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Nonblocking poller: one outstanding request, unique reply channel, 12s timeout.
 * A separate expiry timer calls `onChange` when a fresh reading passes `expiresAt`.
 */
export function createQuotaPoller(deps: PollerDeps): QuotaPoller {
	const now = deps.now ?? Date.now;
	const newId = deps.newId ?? randomUUID;
	const setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
	const clearT = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
	const setI = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
	const clearI = deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

	let state: QuotaState | undefined;
	let disposed = false;
	let inflight: { off: () => void; timer: unknown } | undefined;
	let interval: unknown;
	let expiryTimer: unknown;

	function clearExpiry(): void {
		if (expiryTimer !== undefined) clearT(expiryTimer);
		expiryTimer = undefined;
	}

	/**
	 * Arm a timer for the earliest expiry of a fresh reading or an active mark in `current`.
	 * Only `settle` (never after `dispose`, which drops the in-flight token) and this
	 * timer (cleared by `settle` and `dispose`) call it, so `current` is always the live state.
	 * The timer re-arms only while live, since its `onChange` may dispose the poller.
	 */
	function scheduleExpiry(current: QuotaState): void {
		clearExpiry();
		const t = now();
		let next = Number.POSITIVE_INFINITY;
		for (const quota of Object.values(current)) {
			if (!quota.stale && typeof quota.expiresAt === "number" && quota.expiresAt > t)
				next = Math.min(next, quota.expiresAt);
			for (const cell of quota.cells) {
				if (cell.kind === "mark" && cell.until > t) next = Math.min(next, cell.until);
			}
		}
		if (next === Number.POSITIVE_INFINITY) return;
		expiryTimer = setT(
			() => {
				expiryTimer = undefined;
				if (disposed) return;
				deps.onChange();
				if (!disposed) scheduleExpiry(current);
			},
			Math.min(next - t, MAX_TIMER_MS),
		);
	}

	function settle(token: object, next: QuotaState | undefined): void {
		if (inflight !== token) return;
		inflight.off();
		clearT(inflight.timer);
		inflight = undefined;
		if (next) state = next;
		else if (state) state = markStale(state);
		else return;
		scheduleExpiry(state);
		deps.onChange();
	}

	function request(): void {
		if (disposed || inflight) return;
		const requestId = newId();
		const token = { off: () => {}, timer: undefined as unknown };
		inflight = token;
		token.off = deps.events.on(`${USAGE_CHANNEL}:reply:${requestId}`, (reply) => {
			if (disposed) return;
			settle(token, parseUsageReply(reply, now(), state));
		});
		token.timer = setT(() => settle(token, undefined), REPLY_TIMEOUT_MS);
		try {
			deps.events.emit(USAGE_CHANNEL, { requestId, refresh: true });
		} catch {
			settle(token, undefined);
		}
	}

	return {
		getState: () => (state ? effectiveState(state, now()) : undefined),
		start() {
			if (disposed || interval !== undefined) return;
			request();
			interval = setI(request, POLL_INTERVAL_MS);
		},
		dispose() {
			disposed = true;
			if (interval !== undefined) clearI(interval);
			interval = undefined;
			clearExpiry();
			if (inflight) {
				inflight.off();
				clearT(inflight.timer);
				inflight = undefined;
			}
		},
	};
}
