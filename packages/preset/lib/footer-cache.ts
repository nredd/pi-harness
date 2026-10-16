/**
 * Prompt-cache diagnostics for the expanded footer.
 *
 * Pure helpers, no pi imports, so they can be unit tested without starting pi.
 * Everything is derived from branch entries (root -> leaf) plus a clock; nothing here does I/O.
 *
 * - Marker: `warm` while the last assistant response is younger than the cache TTL, else `cold`.
 * - Cause tag: only when the latest turn's hit rate is below `HEALTHY_HIT_PERCENT` and fell at least
 *   `MIN_DROP_POINTS` from the previous prompt-bearing turn. One of `idle>ttl`, `model-switch`, `compaction`, `prefix-changed`.
 */

/** Anthropic short-retention cache lifetime, seconds; used when the model declares none. */
export const DEFAULT_CACHE_TTL_S = 300;
/** A turn at or above this hit rate (percent) is healthy; a low turn that also dropped sharply is diagnosed. */
export const HEALTHY_HIT_PERCENT = 50;
/** Minimum fall in hit rate (percentage points) from the previous turn for a low turn to get a cause tag. */
export const MIN_DROP_POINTS = 10;

export type CacheCause = "idle>ttl" | "model-switch" | "compaction" | "prefix-changed";
export type CacheTemperature = "warm" | "cold";
export type CacheTier = "full" | "compact";

/** The slice of a session entry this module reads; real `SessionEntry` values satisfy it. */
export interface CacheEntry {
	type: string;
	timestamp?: string;
	message?: {
		role?: string;
		provider?: string;
		model?: string;
		timestamp?: number;
		usage?: { input?: number; cacheRead?: number; cacheWrite?: number };
	};
}

export interface CacheStatus {
	/** Hit rate of the latest assistant turn with prompt tokens, percent; `undefined` when none. */
	hitRate?: number;
	/** `undefined` when the last assistant response has no usable timestamp. */
	temperature?: CacheTemperature;
	/** Set only on a low turn that dropped at least `MIN_DROP_POINTS` from the previous turn. */
	cause?: CacheCause;
	/** Epoch ms when the cache goes cold; `undefined` unless `temperature` is `warm`. Drives a repaint. */
	coldAt?: number;
}

interface Turn {
	index: number;
	hitRate: number;
	at?: number;
	provider?: string;
	model?: string;
}

/**
 * Prompt TTL in seconds from a model's declared `promptCache.short`, else the default.
 * Deliberately not the long-retention tier or a guess: the footer only claims what the model declares.
 */
export function cacheTtlSeconds(promptCache?: { short?: number }): number {
	const short = promptCache?.short;
	return typeof short === "number" && Number.isFinite(short) && short > 0 ? short : DEFAULT_CACHE_TTL_S;
}

function timeOf(entry: CacheEntry): number | undefined {
	const stamp = entry.message?.timestamp;
	if (typeof stamp === "number" && Number.isFinite(stamp)) return stamp;
	const parsed = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
	return Number.isNaN(parsed) ? undefined : parsed;
}

/** Assistant turns that sent a prompt (zero prompt tokens carry no hit rate), oldest first. */
function turnsOf(entries: readonly CacheEntry[]): Turn[] {
	const turns: Turn[] = [];
	entries.forEach((entry, index) => {
		const message = entry.message;
		if (entry.type !== "message" || message?.role !== "assistant" || !message.usage) return;
		const { input = 0, cacheRead = 0, cacheWrite = 0 } = message.usage;
		const prompt = input + cacheRead + cacheWrite;
		if (!(prompt > 0)) return;
		turns.push({
			index,
			hitRate: (cacheRead / prompt) * 100,
			at: timeOf(entry),
			provider: message.provider,
			model: message.model,
		});
	});
	return turns;
}

function diagnose(entries: readonly CacheEntry[], previous: Turn, latest: Turn, ttlMs: number): CacheCause {
	if (previous.at !== undefined && latest.at !== undefined && latest.at - previous.at > ttlMs) return "idle>ttl";
	const switched =
		previous.provider !== undefined &&
		latest.provider !== undefined &&
		previous.model !== undefined &&
		latest.model !== undefined &&
		(previous.provider !== latest.provider || previous.model !== latest.model);
	if (switched) return "model-switch";
	if (entries.slice(previous.index + 1, latest.index).some((entry) => entry.type === "compaction")) return "compaction";
	return "prefix-changed";
}

/**
 * Cache status for the footer.
 *
 * Parameters:
 *   entries: branch entries, root -> leaf.
 *   now: epoch ms.
 *   ttlSeconds: cache lifetime, see `cacheTtlSeconds`.
 */
export function analyzeCache(entries: readonly CacheEntry[], now: number, ttlSeconds: number): CacheStatus {
	const turns = turnsOf(entries);
	const latest = turns.at(-1);
	if (!latest) return {};
	const ttlMs = ttlSeconds * 1000;
	const status: CacheStatus = { hitRate: latest.hitRate };
	if (latest.at !== undefined) {
		const coldAt = latest.at + ttlMs;
		status.temperature = now < coldAt ? "warm" : "cold";
		if (status.temperature === "warm") status.coldAt = coldAt;
	}
	const previous = turns.at(-2);
	if (previous && latest.hitRate < HEALTHY_HIT_PERCENT && previous.hitRate - latest.hitRate >= MIN_DROP_POINTS) {
		status.cause = diagnose(entries, previous, latest, ttlMs);
	}
	return status;
}

/** Compact-tier cause tags: the stats row is tight at 60 columns, so each is at most 7 characters. */
export const COMPACT_CAUSE: Record<CacheCause, string> = {
	"idle>ttl": "idle",
	"model-switch": "model",
	compaction: "compact",
	"prefix-changed": "prefix",
};

/** Text after the hit rate: ` warm`, ` cold idle>ttl`; the compact tier shortens it to ` w`, ` c idle`. Empty when unknown. */
export function formatCacheMarker(status: CacheStatus, tier: CacheTier): string {
	const cause = status.cause ? (tier === "full" ? status.cause : COMPACT_CAUSE[status.cause]) : undefined;
	if (!status.temperature) return cause ? ` ${cause}` : "";
	const word = tier === "full" ? status.temperature : status.temperature[0];
	return cause ? ` ${word} ${cause}` : ` ${word}`;
}
