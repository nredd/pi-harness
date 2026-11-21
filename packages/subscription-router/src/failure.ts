export type FailureClassification =
	| { class: "billing"; scope: "provider"; cause: "billing" }
	| { class: "not-quota"; scope: "model"; cause: "other" }
	| { class: "daily" | "rolling"; scope: "model"; cause: "quota"; resetAt: number }
	| { class: "hinted"; scope: "model"; cause: "quota"; hintMs: number }
	| { class: "per-minute" | "unknown-quota" | "weak"; scope: "model"; cause: "quota" };

const PACIFIC = new Intl.DateTimeFormat("en-US", {
	timeZone: "America/Los_Angeles",
	year: "numeric",
	month: "numeric",
	day: "numeric",
	hour: "numeric",
	minute: "numeric",
	second: "numeric",
	hourCycle: "h23",
});
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

function pacificParts(at: number) {
	return Object.fromEntries(PACIFIC.formatToParts(at).map(({ type, value }) => [type, Number(value)]));
}

/** Next Pacific midnight, strictly after a valid epoch timestamp. DST shifts can make the day 23 or 25 hours. */
export function nextPacificMidnight(now: number): number {
	const { year, month, day } = pacificParts(now);
	const date = new Date(0);
	date.setUTCFullYear(Number(year), Number(month) - 1, Number(day) + 1);
	// Probe at 08:00 UTC, at or just after midnight in Los Angeles, before the DST change at 02:00.
	const probe = date.setUTCHours(8);
	const { hour, minute, second } = pacificParts(probe);
	return probe - (Number(hour) * 60 * MINUTE + Number(minute) * MINUTE + Number(second) * SECOND);
}

const LEADING_STATUS = /^(?:HTTP(?:\/\d(?:\.\d)?)?\s+)?([45]\d{2})(?=$|\s|:)/i;
const BODY_STATUS = /[{,]\s*"code"\s*:\s*([45]\d{2})(?=$|\s|[,}])/i;
const STOPPED = /^Provider stopped with:/i;
const NON_QUOTA =
	/\b(?:Provider stopped with:|SAFETY\b|blocked\b|blockReason"\s*:|unauthorized\b|unauthenticated\b|forbidden\b|permission[ _]denied\b|overloaded\b|model_capacity_exhausted\b|unavailable\b|network\b|ECONNRESET\b|ECONNREFUSED\b|ENOTFOUND\b|ETIMEDOUT\b|fetch failed\b|socket hang up\b)/i;
const VERDICT = /\b(?:RESOURCE_EXHAUSTED|rate_limit_error|rate_limit_exceeded|too_many_requests|QUOTA_EXHAUSTED)\b/i;
const LEGACY_LIMIT =
	/\b(?:UsageLimitError|subscription_sharing_usage_limit_exceeded|usage_limit_reached|insufficient_quota|quota exceeded|rate[ -]limit(?:ed| exceeded)|too many requests|out of budget|extra[ -]usage (?:limit|disabled|exhausted)|(?:insufficient|no) available balance)\b/i;
const BILLING = /\b(?:billing|credits depleted|prepayment credits|payment required)\b/i;
const WEAK =
	/\b(?:429|402)\b|quota|rate.?limit|too many requests|usage.?limit|out of budget|extra.?usage|available balance/i;
const DAILY = /PerDay|Daily/i;
const PER_MINUTE = /PerMinute/i;
// Only an explicit spend-window signal, not an arbitrary mention of spend in a 429.
const SPEND_WINDOW = /SpendPer10Minutes|\bspend-10m\b|\b10[- ]minute spend (?:cap|limit)\b/i;

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function string(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function list(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function parseBody(text: string): Record<string, unknown> | undefined {
	const start = text.indexOf("{");
	if (start < 0) return undefined;
	try {
		return record(JSON.parse(text.slice(start)));
	} catch {
		// Core can truncate the response body. Fall back to the intact fields in the text.
		return undefined;
	}
}

function rpcSignals(body: Record<string, unknown>) {
	const error = record(body.error ?? body);
	const codes = [error.status, error.type, error.code].map(string);
	const quotaIds: string[] = [];
	const delays: string[] = [];
	for (const value of list(error.details)) {
		const detail = record(value);
		const type = string(detail["@type"]);
		if (/(?:^|[./])QuotaFailure$/.test(type)) {
			for (const violation of list(detail.violations)) quotaIds.push(string(record(violation).quotaId));
		} else if (/(?:^|[./])RetryInfo$/.test(type)) {
			delays.push(string(detail.retryDelay));
		} else if (/(?:^|[./])ErrorInfo$/.test(type)) {
			codes.push(string(detail.reason));
			quotaIds.push(string(record(detail.metadata).quota_limit));
		}
	}
	return { status: error.code, codes, prose: string(error.message), quotaIds, delays };
}

function rawSignals(text: string) {
	return {
		status: Number(BODY_STATUS.exec(text)?.[1]),
		codes: [...text.matchAll(/[{,]\s*"(?:status|type|code|reason)"\s*:\s*"(\w+)"/g)].map((match) => match[1]),
		// Do not treat arbitrary JSON values (or a cut-off quotaId) as prose window markers.
		prose: string(/[{,]\s*"message"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(text)?.[1]),
		quotaIds: [...text.matchAll(/[{,]\s*"(?:quotaId|quota_limit)"\s*:\s*"([^"\r\n]*)"/g)].map((match) =>
			string(match[1]),
		),
		delays: [...text.matchAll(/[{,]\s*"retryDelay"\s*:\s*"(\d+(?:\.\d+)?s)"/g)].map((match) => string(match[1])),
	};
}

function retryHint(delays: string[], prose: string): number | undefined {
	for (const delay of [
		...delays,
		...[...prose.matchAll(/\bretry in\s+(\d+(?:\.\d+)?s)\b/gi)].map((match) => string(match[1])),
	]) {
		if (!/^\d+(?:\.\d+)?s$/i.test(delay)) continue;
		const ms = Number(delay.slice(0, -1)) * SECOND;
		if (Number.isFinite(ms)) return ms;
	}
	return undefined;
}

/** Classify evidence, not marks. The caller owns repeat thresholds and caps the resulting expiry. */
export function classify(errorMessage: string | undefined, now: number): FailureClassification {
	const text = (errorMessage ?? "").trim();
	const leading = LEADING_STATUS.exec(text);
	const body = parseBody(text);
	const { status, codes, prose, quotaIds, delays } = body ? rpcSignals(body) : rawSignals(text);
	const http = leading ? Number(leading[1]) : status;
	const prefix = string(text.split("{", 1)[0]);
	const message = `${prefix} ${prose}`.trim();
	const signal = [...codes, message].join(" ");
	const quota = { scope: "model", cause: "quota" } as const;
	// Negative evidence wins even when the message contains quota/billing words or a retry hint.
	if (
		STOPPED.test(text) ||
		http === 401 ||
		http === 403 ||
		(typeof http === "number" && http >= 500) ||
		NON_QUOTA.test(signal)
	) {
		return { class: "not-quota", scope: "model", cause: "other" };
	}
	if (http === 402 || BILLING.test(signal)) return { class: "billing", scope: "provider", cause: "billing" };
	const interactionsDaily = codes.includes("quota_exceeded") || message === "quota_exceeded";
	if (http === 429 || VERDICT.test(signal) || LEGACY_LIMIT.test(signal) || interactionsDaily) {
		const windows = quotaIds.join(" ");
		// The prose fallback accepts explicit window tokens, not arbitrary mentions of the word daily.
		if (PER_MINUTE.test(windows) || /\bPerMinute\b/i.test(message)) return { class: "per-minute", ...quota };
		if (interactionsDaily || DAILY.test(windows) || /\b(?:PerDay|daily (?:quota|limit))\b/i.test(message)) {
			return { class: "daily", resetAt: nextPacificMidnight(now), ...quota };
		}
		if (SPEND_WINDOW.test(`${windows} ${message}`)) return { class: "rolling", resetAt: now + 10 * MINUTE, ...quota };
		const hintMs = retryHint(delays, message);
		if (hintMs === undefined) return { class: "unknown-quota", ...quota };
		if (hintMs < MINUTE) return { class: "per-minute", ...quota };
		return { class: "hinted", hintMs, ...quota };
	}
	if (WEAK.test(signal)) return { class: "weak", ...quota };
	return { class: "not-quota", scope: "model", cause: "other" };
}
