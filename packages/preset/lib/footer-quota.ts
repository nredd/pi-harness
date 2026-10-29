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

/** Router `durationMs` of a weekly window. */
const WEEK_MS = 604_800_000;

/**
 * Providers shown, in order, with their router ids. A provider without a `fiveHour` window
 * name has no 5h quota (OpenAI Codex), so none is shown. `identify` says how the weekly
 * window is recognised: `name` (Anthropic's fixed `seven_day`), or `span` (OpenAI: a
 * reported 604800000 ms duration, or the legacy `7d` name on snapshots without `spanSource`).
 */
export const QUOTA_PROVIDERS = [
	{
		id: "anthropic",
		full: "Anthropic",
		compact: "Anth",
		fiveHour: "five_hour",
		weekly: "seven_day",
		identify: "name",
	},
	{
		id: "openai-codex",
		full: "OpenAI",
		compact: "OAI",
		weekly: "7d",
		identify: "span",
	},
] as const satisfies readonly QuotaProviderSpec[];

interface QuotaProviderSpec {
	id: string;
	full: string;
	compact: string;
	fiveHour?: string;
	weekly: string;
	identify: "name" | "span";
}

/**
 * Last known remaining percentages (0-100) for one provider; `undefined` renders `--`.
 * `stale` is what the router reported; use `getState()` for effective staleness,
 * which also accounts for `expiresAt` passing.
 */
export interface ProviderQuota {
	fiveHour?: number;
	/** Epoch ms the 5h window resets, as reported by the router; absent when unknown. */
	fiveHourResetAt?: number;
	weekly?: number;
	/** Epoch ms the weekly window resets, as reported by the router; absent when unknown. */
	weeklyResetAt?: number;
	/**
	 * True when `weekly`/`weeklyResetAt` describe a window whose span the router only assumed
	 * (`spanSource: "assumed"`): it is shown as an unidentified quota, never as weekly.
	 */
	weeklyUnknown?: boolean;
	stale: boolean;
	/** Epoch ms after which a fresh reading is stale. Absent: never fresh. */
	expiresAt?: number;
}

export type QuotaState = Record<string, ProviderQuota>;

/** Remaining percent from a used percent: clamp 0..100, floor remaining; invalid -> `undefined`. */
export function remainingPercent(used: unknown): number | undefined {
	if (typeof used !== "number" || !Number.isFinite(used)) return undefined;
	return Math.floor(100 - Math.min(100, Math.max(0, used)));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

type WindowReading = Pick<ProviderQuota, "fiveHour" | "fiveHourResetAt" | "weekly" | "weeklyResetAt" | "weeklyUnknown">;

/** Epoch ms from a router `resetAt`; non-finite or non-positive -> `undefined`. */
function resetAtOf(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Whether a router window is proven weekly for a span-identified provider: a reported
 * 604800000 ms duration, or, only when the snapshot predates `spanSource`, the legacy `7d` name.
 */
function isReportedWeekly(window: Record<string, unknown>, spec: QuotaProviderSpec): boolean {
	if (window.spanSource === undefined) return window.name === spec.weekly;
	return window.spanSource === "reported" && window.durationMs === WEEK_MS;
}

function readingOf(window: Record<string, unknown>, key: "fiveHour" | "weekly"): WindowReading {
	const out: WindowReading = { [key]: remainingPercent(window.usedPercent) };
	const resetAt = resetAtOf(window.resetAt);
	if (resetAt !== undefined) out[`${key}ResetAt`] = resetAt;
	return out;
}

/**
 * Remaining percents and reset times of the provider-scoped windows. Reset keys exist only when known.
 * Span-identified providers: weekly is the first proven-weekly window. Only if none exists and
 * the router reported windows with an assumed span, the most limiting of those is kept as an
 * unidentified quota (`weeklyUnknown`); reported non-weekly spans (e.g. 18000s) stay hidden.
 */
function readWindows(windows: unknown[], spec: QuotaProviderSpec): WindowReading {
	const provider = windows.flatMap((raw) => {
		const window = asRecord(raw);
		return window?.scope === "provider" ? [window] : [];
	});
	if (spec.identify === "name") {
		const out: WindowReading = {};
		for (const window of provider) {
			const key = window.name === spec.fiveHour ? "fiveHour" : window.name === spec.weekly ? "weekly" : undefined;
			if (key) Object.assign(out, readingOf(window, key));
		}
		return out;
	}
	const weekly = provider.find((window) => isReportedWeekly(window, spec));
	if (weekly) return readingOf(weekly, "weekly");
	const assumed = provider.filter((window) => window.spanSource === "assumed");
	const percent = (window: Record<string, unknown>) => remainingPercent(window.usedPercent);
	let limiting: Record<string, unknown> | undefined;
	for (const window of assumed) {
		const left = percent(window);
		if (limiting === undefined || (left !== undefined && (percent(limiting) ?? 101) > left)) limiting = window;
	}
	return limiting ? { ...readingOf(limiting, "weekly"), weeklyUnknown: true } : {};
}

/**
 * Per window: a valid new percent brings its own reset time (and identity); otherwise the prior
 * pair is retained. An unidentified new reading never displaces a retained proven-weekly one.
 */
function mergeReadings(seen: WindowReading, prior: ProviderQuota | undefined): WindowReading {
	const out: WindowReading = {};
	for (const key of ["fiveHour", "weekly"] as const) {
		const usable =
			seen[key] !== undefined &&
			!(key === "weekly" && seen.weeklyUnknown && prior?.weekly !== undefined && !prior.weeklyUnknown);
		const source = usable ? seen : prior;
		out[key] = source?.[key];
		const resetAt = source?.[`${key}ResetAt`];
		if (resetAt !== undefined) out[`${key}ResetAt`] = resetAt;
		if (key === "weekly" && source?.weeklyUnknown) out.weeklyUnknown = true;
	}
	return out;
}

/**
 * Validate an RPC reply envelope (`{ success, data: { snapshots } }`) into a state.
 * Returns `undefined` for a malformed or unsuccessful envelope.
 *
 * A snapshot is fresh only if `status` is `available`, `windows` is a non-empty array and
 * `expiresAt` is finite and in the future. A fresh snapshot replaces the provider
 * wholesale (a missing or invalid window shows `--`). Anything else, including a
 * provider absent from the reply, is stale: values merge per field over `previous`
 * (valid snapshot values win, the rest are retained; a retained percent keeps its reset time).
 */
export function parseUsageReply(reply: unknown, now: number, previous?: QuotaState): QuotaState | undefined {
	const envelope = asRecord(reply);
	if (envelope?.success !== true) return undefined;
	const snapshots = asRecord(envelope.data)?.snapshots;
	if (!Array.isArray(snapshots)) return undefined;

	const state: QuotaState = {};
	for (const spec of QUOTA_PROVIDERS) {
		const snapshot = asRecord(snapshots.find((raw) => asRecord(raw)?.provider === spec.id));
		const prior = previous?.[spec.id];
		const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : undefined;
		const expiresAt = snapshot?.expiresAt;
		const fresh =
			snapshot !== undefined &&
			typeof snapshot.status === "string" &&
			snapshot.status === "available" &&
			windows !== undefined &&
			windows.length > 0 &&
			typeof expiresAt === "number" &&
			Number.isFinite(expiresAt) &&
			expiresAt > now;
		if (fresh) {
			state[spec.id] = {
				...readWindows(windows, spec),
				stale: false,
				expiresAt,
			};
			continue;
		}
		const seen = windows ? readWindows(windows, spec) : {};
		state[spec.id] = {
			...mergeReadings(seen, prior),
			stale: true,
			expiresAt: prior?.expiresAt,
		};
	}
	return state;
}

/** Mark every provider stale, retaining values (error, timeout). */
export function markStale(state: QuotaState): QuotaState {
	return Object.fromEntries(Object.entries(state).map(([id, quota]) => [id, { ...quota, stale: true }]));
}

/** Whether a provider reading is stale at `now`: flagged, or expiry missing, invalid or passed. */
export function isStale(quota: ProviderQuota, now: number): boolean {
	return (
		quota.stale || typeof quota.expiresAt !== "number" || !Number.isFinite(quota.expiresAt) || quota.expiresAt <= now
	);
}

/** Copy of `state` with effective staleness at `now`; cached figures are kept. */
export function effectiveState(state: QuotaState, now: number): QuotaState {
	return Object.fromEntries(Object.entries(state).map(([id, quota]) => [id, { ...quota, stale: isStale(quota, now) }]));
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
}

function windowText(
	label: string,
	remaining: number | undefined,
	resetAt: number | undefined,
	weekly: boolean,
	layout: Layout,
	colorize: Colorize,
	opts: Required<Pick<FormatOptions, "now">> & FormatOptions,
	unidentified = false,
): string {
	const dim = (text: string) => colorize("dim", text);
	const value = formatValue(remaining, colorize);
	// Percent and freshness are never altered by the reset; a missing or already-past reset is just not shown.
	const when =
		layout.resets && resetAt !== undefined && resetAt > opts.now
			? formatResetAt(resetAt, opts.now, opts.timeZone, weekly)
			: undefined;
	const full = layout.tier === "full";
	const name = unidentified && !full ? `${label}?` : label;
	// An unidentified window states that in the full tier; compact carries it as the `?` on the label.
	const note = unidentified && full ? "window unknown" : undefined;
	const parts = full ? [when ? `resets ${when}` : undefined, note].filter(Boolean).join("; ") : "";
	const suffix = full ? (parts ? ` (${parts})` : "") : when ? ` @${when}` : "";
	return `${dim(`${name} `)}${value}${dim(suffix)}`;
}

function providerRows(state: QuotaState, layout: Layout, colorize: Colorize, opts: FormatOptions): string[] {
	const full = layout.tier === "full";
	const dim = (text: string) => colorize("dim", text);
	const resolved = { ...opts, now: opts.now ?? Date.now() };
	const segments = (QUOTA_PROVIDERS as readonly QuotaProviderSpec[]).map((spec) => {
		const quota = state[spec.id] ?? { stale: true };
		const label = `${full ? spec.full : spec.compact}${quota.stale ? " (stale)" : ""}`;
		const windows: string[] = [];
		if (spec.fiveHour !== undefined)
			windows.push(windowText("5h", quota.fiveHour, quota.fiveHourResetAt, false, layout, colorize, resolved));
		const unidentified = quota.weeklyUnknown === true;
		const weeklyLabel = unidentified ? "quota" : full ? "weekly" : "7d";
		windows.push(
			windowText(weeklyLabel, quota.weekly, quota.weeklyResetAt, true, layout, colorize, resolved, unidentified),
		);
		return `${dim(`${label} `)}${windows.join(" ")}`;
	});
	const lead = dim(full ? "Quota left: " : "Left: ");
	if (layout.split) return segments.map((segment, i) => (i === 0 ? lead + segment : segment));
	return [lead + segments.join(dim(" | "))];
}

/**
 * Single row text for one tier, with reset times; always lists both providers. Labels are
 * dimmed and low values colored individually, so a value color never bleeds into the rest.
 * Windows with an unknown or already-past reset omit it (the percent is unchanged); OpenAI shows only its weekly window, or an `unknown window` quota when the router could not prove the span.
 */
export function formatQuotaRow(state: QuotaState, tier: Tier, colorize: Colorize, opts: FormatOptions = {}): string {
	return providerRows(state, { tier, resets: true, split: false }, colorize, opts).join("\n");
}

const NARROWEST: Layout = { tier: "compact", resets: false, split: true };
/** Widest first; `NARROWEST` is the last resort callers may still clip. */
const LAYOUTS: readonly Layout[] = [
	{ tier: "full", resets: true, split: false },
	{ tier: "compact", resets: true, split: false },
	{ tier: "compact", resets: true, split: true },
	NARROWEST,
];

/**
 * Rows for a terminal `width`, widest layout that fits untruncated: full single row, compact
 * single row, one compact row per provider, then the same without reset times. Narrow widths
 * wrap by provider rather than clip, so every value stays next to its provider label. Only the
 * narrowest layout can still exceed `width`; callers clip that last resort.
 */
export function fitQuotaRows(state: QuotaState, width: number, colorize: Colorize, opts: FormatOptions = {}): string[] {
	const plain: Colorize = (_color, text) => text;
	const resolved = { ...opts, now: opts.now ?? Date.now() };
	// Rows are ASCII (en-US month names, digits, `%`), so `.length` equals the visible width here.
	const fits = (layout: Layout) => providerRows(state, layout, plain, resolved).every((row) => row.length <= width);
	return providerRows(state, LAYOUTS.find(fits) ?? NARROWEST, colorize, resolved);
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

	/** Arm a timer for the earliest upcoming expiry of a fresh reading. */
	function scheduleExpiry(): void {
		clearExpiry();
		if (disposed || !state) return;
		const t = now();
		let next = Number.POSITIVE_INFINITY;
		for (const quota of Object.values(state)) {
			if (!quota.stale && typeof quota.expiresAt === "number" && quota.expiresAt > t)
				next = Math.min(next, quota.expiresAt);
		}
		if (next === Number.POSITIVE_INFINITY) return;
		expiryTimer = setT(
			() => {
				expiryTimer = undefined;
				if (disposed) return;
				deps.onChange();
				scheduleExpiry();
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
		scheduleExpiry();
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
