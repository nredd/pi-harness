import type { Collector, CollectorReading } from "./collectors.ts";
import type { UsageWindow } from "./usage.ts";

/** Numeric reset times below this are Unix seconds, above it milliseconds (1e11 s is the year 5138). */
const SECONDS_VS_MS_THRESHOLD = 100_000_000_000;
/** Reported 5h and 7d quota-window spans. */
const FIVE_HOURS_MS = 5 * 60 * 60_000;
const WEEK_MS = 7 * 24 * 60 * 60_000;
/** Beta flag the Anthropic usage endpoint requires for OAuth bearer tokens. */
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";
/** Requests without a claude-code User-Agent land in an aggressively 429'd bucket (anthropics/claude-code#31637). */
const ANTHROPIC_USER_AGENT = "claude-code/2.1";
/** Anthropic console API keys have no subscription window to report. */
const ANTHROPIC_API_KEY_PREFIX = "sk-ant-api";
/** JWT claim namespace carrying the ChatGPT account id in Codex access tokens. */
const CODEX_JWT_CLAIM_PATH = "https://api.openai.com/auth";
/** Antigravity's quota summary endpoint; the `cloudcode-pa` fallback host is not read. */
const ANTIGRAVITY_QUOTA_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
/** The Antigravity CLI wire fingerprint the endpoint expects. */
const ANTIGRAVITY_USER_AGENT =
	"antigravity/cli/1.5.5 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)";
/** Antigravity bucket ID prefixes and the model families each gates; window names get `namePrefix`. */
const ANTIGRAVITY_BUCKETS = [
	{ prefix: "gemini-", families: ["gemini"], namePrefix: "" },
	{ prefix: "3p-", families: ["claude", "gpt"], namePrefix: "3p-" },
] as const;
/** Reported Antigravity `window` values, as window name suffix and span. */
const ANTIGRAVITY_WINDOWS: ReadonlyMap<unknown, { name: string; durationMs: number }> = new Map([
	["5h", { name: "5h", durationMs: FIVE_HOURS_MS }],
	["weekly", { name: "7d", durationMs: WEEK_MS }],
]);

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Epoch ms from Unix seconds, epoch ms, or an RFC 3339 / HTTP-date string. */
function timestamp(value: unknown): number | undefined {
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	const raw = finiteNumber(value);
	if (raw === undefined) return undefined;
	const ms = raw < SECONDS_VS_MS_THRESHOLD ? raw * 1000 : raw;
	return Number.isNaN(new Date(ms).getTime()) ? undefined : ms;
}

function percentage(value: unknown): number | undefined {
	const raw = finiteNumber(value);
	if (raw === undefined || raw < 0) return undefined;
	return Math.min(raw, 100);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/** Parse the Anthropic `/api/oauth/usage` payload. */
export function parseAnthropic(payload: unknown): CollectorReading | undefined {
	const root = asRecord(payload);
	if (!root) return undefined;
	const windows: UsageWindow[] = [];
	const specs = [
		["five_hour", undefined],
		["seven_day", undefined],
		["seven_day_opus", ["opus"]],
		["seven_day_sonnet", ["sonnet"]],
	] as const;
	for (const [key, families] of specs) {
		const item = asRecord(root[key]);
		if (!item) continue;
		const usedPercent = percentage(item.utilization ?? item.used_percentage);
		if (usedPercent === undefined) continue;
		windows.push({
			name: key,
			usedPercent,
			resetAt: timestamp(item.resets_at ?? item.reset_at),
			durationMs: key === "five_hour" ? FIVE_HOURS_MS : WEEK_MS,
			spanSource: "reported",
			scope: families ? "model" : "provider",
			families: families ? [...families] : undefined,
		});
	}
	for (const window of anthropicScopedLimits(root.limits)) {
		if (!windows.some((existing) => existing.name === window.name)) windows.push(window);
	}
	return windows.length === 0 ? undefined : { windows };
}

/**
 * Model-scoped weekly windows Anthropic reports only in its `limits` list, e.g. Fable's
 * `{ kind: "weekly_scoped", scope: { model: { display_name: "Fable" } } }`. Each becomes a
 * `seven_day_<family>` window gating the lowercased display name; names that are not one
 * family token are skipped rather than guessed. Entries narrowed by a non-null `scope.surface`
 * or `scope.model.id` are skipped too: a cap on one surface or one model id must not block
 * the whole family. That fails open: an id- or surface-scoped cap is not enforced, and a 429
 * against it still falls through the normal retry path.
 */
function anthropicScopedLimits(limits: unknown): UsageWindow[] {
	if (!Array.isArray(limits)) return [];
	const windows: UsageWindow[] = [];
	for (const entry of limits) {
		const item = asRecord(entry);
		if (item?.kind !== "weekly_scoped") continue;
		const scope = asRecord(item.scope);
		const model = asRecord(scope?.model);
		if (scope?.surface != null || model?.id != null) continue;
		const displayName = model?.display_name;
		const family = typeof displayName === "string" ? displayName.trim().toLowerCase() : "";
		if (!/^[a-z0-9]+$/.test(family)) continue;
		const usedPercent = percentage(item.percent);
		if (usedPercent === undefined) continue;
		windows.push({
			name: `seven_day_${family}`,
			usedPercent,
			resetAt: timestamp(item.resets_at),
			durationMs: WEEK_MS,
			spanSource: "reported",
			scope: "model",
			families: [family],
		});
	}
	return windows;
}

/** Parse the ChatGPT Codex `wham/usage` payload. */
export function parseCodex(payload: unknown): CollectorReading | undefined {
	const root = asRecord(payload);
	const limits = asRecord(root?.rate_limit);
	if (!root || !limits) return undefined;
	const windows: UsageWindow[] = [];
	for (const [key, name] of [
		["primary_window", "5h"],
		["secondary_window", "7d"],
	] as const) {
		const item = asRecord(limits[key]);
		if (!item) continue;
		const usedPercent = percentage(item.used_percent);
		if (usedPercent === undefined) continue;
		// Plans can expose a weekly primary window with no secondary window.
		// Prefer the reported duration; positional names are legacy fallbacks only.
		const duration = finiteNumber(item.limit_window_seconds);
		const windowName =
			duration === 604_800 ? "7d" : duration === 18_000 ? "5h" : duration && duration > 0 ? `${duration}s` : name;
		windows.push({
			name: windowName,
			usedPercent,
			resetAt: timestamp(item.reset_at),
			scope: "provider",
			durationMs: duration && duration > 0 ? duration * 1000 : key === "primary_window" ? FIVE_HOURS_MS : WEEK_MS,
			spanSource: duration && duration > 0 ? "reported" : "assumed",
		});
	}
	if (windows.length === 0) return undefined;
	const credits = asRecord(root.credits);
	if (!credits) return { windows };
	return {
		windows,
		credits: {
			available: credits.has_credits === true,
			unlimited: credits.unlimited === true,
			balance: typeof credits.balance === "string" ? credits.balance : undefined,
		},
	};
}

/** `chatgpt_account_id` from a Codex access-token JWT, or undefined when not decodable. */
function codexAccountId(token: string): string | undefined {
	const parts = token.split(".");
	if (parts.length !== 3 || !parts[1]) return undefined;
	try {
		const payload = asRecord(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")));
		const accountId = asRecord(payload?.[CODEX_JWT_CLAIM_PATH])?.chatgpt_account_id;
		// An empty id comes back as is; the header builder omits it like a missing one.
		return typeof accountId === "string" ? accountId : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Parse the Antigravity `retrieveUserQuotaSummary` payload. Each `groups[].buckets[]` entry with a
 * known `bucketId` prefix and `window` becomes a model-scoped window: `gemini-*` gates the `gemini`
 * family, `3p-*` the `claude` and `gpt` families. `remainingFraction` (0..1, clamped) becomes
 * `usedPercent`; a bucket without a finite fraction is skipped. `resetTime` is absent while a
 * bucket is untouched, which leaves the reset unknown.
 */
export function parseAntigravity(payload: unknown): CollectorReading | undefined {
	const groups = asRecord(payload)?.groups;
	if (!Array.isArray(groups)) return undefined;
	const windows: UsageWindow[] = [];
	for (const group of groups) {
		const buckets = asRecord(group)?.buckets;
		if (!Array.isArray(buckets)) continue;
		for (const entry of buckets) {
			const bucket = asRecord(entry);
			const id = bucket?.bucketId;
			const kind = typeof id === "string" ? ANTIGRAVITY_BUCKETS.find(({ prefix }) => id.startsWith(prefix)) : undefined;
			const span = ANTIGRAVITY_WINDOWS.get(bucket?.window);
			const remaining = finiteNumber(bucket?.remainingFraction);
			if (!kind || !span || remaining === undefined) continue;
			const name = `${kind.namePrefix}${span.name}`;
			if (windows.some((existing) => existing.name === name)) continue;
			windows.push({
				name,
				usedPercent: (1 - Math.min(Math.max(remaining, 0), 1)) * 100,
				resetAt: timestamp(bucket?.resetTime),
				durationMs: span.durationMs,
				spanSource: "reported",
				scope: "model",
				families: [...kind.families],
			});
		}
	}
	return windows.length === 0 ? undefined : { windows };
}

/** The access token in the `{"token","projectId"}` JSON credential Pi's `antigravity` provider hands out. */
function antigravityToken(credential: string): string | undefined {
	try {
		const token = asRecord(JSON.parse(credential))?.token;
		return typeof token === "string" && token.length > 0 ? token : undefined;
	} catch {
		return undefined;
	}
}

export const BUILTIN_COLLECTORS: readonly Readonly<Collector>[] = Object.freeze(
	(
		[
			{
				provider: "anthropic",
				kind: "http",
				display: {
					full: "Anthropic",
					compact: "Anth",
					footer: { show: [{ name: "five_hour" }, { name: "seven_day" }], placeholder: true },
				},
				request: (token) => ({
					url: "https://api.anthropic.com/api/oauth/usage",
					headers: {
						Authorization: `Bearer ${token}`,
						"anthropic-beta": ANTHROPIC_OAUTH_BETA,
						"User-Agent": ANTHROPIC_USER_AGENT,
					},
				}),
				parse: parseAnthropic,
				acceptsCredential: (token) => !token.startsWith(ANTHROPIC_API_KEY_PREFIX),
			},
			{
				provider: "openai-codex",
				kind: "http",
				display: { full: "OpenAI", compact: "OAI", footer: { show: [{ durationMs: WEEK_MS }], placeholder: true } },
				request: (token) => {
					const accountId = codexAccountId(token);
					const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
					if (accountId) headers["ChatGPT-Account-Id"] = accountId;
					return { url: "https://chatgpt.com/backend-api/wham/usage", headers };
				},
				parse: parseCodex,
			},
			{
				provider: "antigravity",
				kind: "http",
				display: {
					full: "Gemini",
					compact: "Gem",
					footer: { show: [{ name: "5h" }, { name: "7d" }], placeholder: true },
				},
				request: (credential) => ({
					url: ANTIGRAVITY_QUOTA_URL,
					method: "POST",
					headers: {
						Authorization: `Bearer ${antigravityToken(credential) ?? ""}`,
						"Content-Type": "application/json",
						Accept: "application/json",
						"User-Agent": ANTIGRAVITY_USER_AGENT,
					},
					body: "{}",
				}),
				parse: parseAntigravity,
				acceptsCredential: (credential) => antigravityToken(credential) !== undefined,
			},
		] satisfies Collector[]
	).map((collector) => Object.freeze(collector)),
);
