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

/** Providers shown, in order, with their router ids and window names. */
export const QUOTA_PROVIDERS = [
	{
		id: "anthropic",
		full: "Anthropic",
		compact: "Anth",
		fiveHour: "five_hour",
		weekly: "seven_day",
	},
	{
		id: "openai-codex",
		full: "OpenAI",
		compact: "OAI",
		fiveHour: "5h",
		weekly: "7d",
	},
] as const;

/**
 * Last known remaining percentages (0-100) for one provider; `undefined` renders `--`.
 * `stale` is what the router reported; use `getState()` for effective staleness,
 * which also accounts for `expiresAt` passing.
 */
export interface ProviderQuota {
	fiveHour?: number;
	weekly?: number;
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

/** Remaining percents of the provider-scoped 5h and weekly windows. */
function readWindows(
	windows: unknown[],
	spec: (typeof QUOTA_PROVIDERS)[number],
): Pick<ProviderQuota, "fiveHour" | "weekly"> {
	const out: Pick<ProviderQuota, "fiveHour" | "weekly"> = {};
	for (const rawWindow of windows) {
		const window = asRecord(rawWindow);
		if (window?.scope !== "provider") continue;
		if (window.name === spec.fiveHour) out.fiveHour = remainingPercent(window.usedPercent);
		else if (window.name === spec.weekly) out.weekly = remainingPercent(window.usedPercent);
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
 * (valid snapshot values win, the rest are retained).
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
			fiveHour: seen.fiveHour ?? prior?.fiveHour,
			weekly: seen.weekly ?? prior?.weekly,
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

/**
 * Row text for one tier; always lists both providers. Labels are dimmed and low
 * values colored individually, so a value color never bleeds into the rest.
 */
export function formatQuotaRow(state: QuotaState, tier: Tier, colorize: Colorize): string {
	const full = tier === "full";
	const dim = (text: string) => colorize("dim", text);
	const providers = QUOTA_PROVIDERS.map((spec) => {
		const quota = state[spec.id] ?? { stale: true };
		const label = `${full ? spec.full : spec.compact}${quota.stale ? " (stale)" : ""}`;
		const fiveHour = formatValue(quota.fiveHour, colorize);
		const weekly = formatValue(quota.weekly, colorize);
		return `${dim(`${label} 5h `)}${fiveHour}${dim(full ? " weekly " : " 7d ")}${weekly}`;
	});
	return `${dim(full ? "Quota left: " : "Left: ")}${providers.join(dim(" | "))}`;
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
