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

const LEADING_STATUS = /^(?:HTTP(?:\/\d(?:\.\d)?)?\s+)?([45]\d{2})(?=$|\s|:)(?!\s+(?:tokens?|bytes?|requests?)\b)/i;
// Core's `formatProviderError` with a prefix: `<prefix> (<status>): <body>`.
const PREFIXED_STATUS = /^[^{}()\r\n]*\(([45]\d{2})\)\s*:/;
const JSON_TOKEN =
	/\s*(?:"(?:[^"\\\r\n]|\\.)*"|[{}[\],:]|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\w.+-]))/y;
const CUT_MESSAGE = /^\s*,?\s*"message"\s*:\s*"(?:[^"\\\r\n]|\\.)*$/;
// Negative evidence is a status (checked separately), an error type, a transport error code or an
// explicit safety verdict, never free text: "requests are blocked" can be the quota message itself.
const NON_QUOTA_TYPE = /\b(?:SAFETY|UNAUTHENTICATED|PERMISSION_DENIED|UNAVAILABLE)\b/;
const NON_QUOTA_CODE =
	/\b(?:Provider stopped with:|authentication_error\b|permission_error\b|model_capacity_exhausted\b|ECONNRESET\b|ECONNREFUSED\b|ENOTFOUND\b|ETIMEDOUT\b|fetch failed\b|socket hang up\b)/i;
const OVERLOAD = /(?:^|[^a-z0-9])overloaded(?![a-z0-9])/i;
const VERDICT = /\b(?:RESOURCE_EXHAUSTED|rate_limit_error|rate_limit_exceeded|too_many_requests|QUOTA_EXHAUSTED)\b/i;
const LEGACY_LIMIT =
	/\b(?:UsageLimitError|subscription_sharing_usage_limit_exceeded|usage_limit_reached|insufficient_quota|quota exceeded|rate[ -]limit(?:ed| exceeded)|too many requests|out of budget|out of extra[ _-]?usage|extra[ -]usage (?:limit|disabled|exhausted)|(?:insufficient|no) available balance)\b/i;
// Bare labels can be verdicts; the same words in arbitrary prose are only weak signals.
const LEGACY_LABEL = /^(?:quota|rate.?limit|usage.?limit|extra.?usage|available balance)$/i;
// Affirmative payment exhaustion only. A bare mention of billing is weak: it can be an address or a service name.
const BILLING =
	/\b(?:credits? (?:depleted|exhausted)|(?:no|insufficient) (?:prepayment )?credits?\b|insufficient (?:balance|funds)\b|credit balance is too low|payment required|billing hard limit|billing account (?:is )?(?:disabled|suspended|inactive)\b)/i;
const WEAK =
	/\b(?:429|402)\b|quota|billing|rate.?limit|too many requests|usage.?limit|out of budget|extra.?usage|available balance/i;
const DAILY = /PerDay|Daily/i;
const PER_MINUTE = /PerMinute/i;
const DAILY_TOKEN = /\b(?:RequestsPerDay\b|Per[ -]?Day\b|Daily(?:\s+(?:quota|limit)\b|(?=\s*(?:$|[.,;:)!]))))/i;
const PER_MINUTE_TOKEN = /\b(?:RequestsPerMinute|Per[ -]?Minute)\b/i;
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

function parseJson(text: string): Record<string, unknown> | undefined {
	try {
		return record(JSON.parse(text));
	} catch {
		return undefined;
	}
}

// Complete the longest token prefix we can close. JSON.parse checks the recovered
// structure; RPC fields still have to pass the same path and type checks as full JSON.
function recoverBody(text: string): Record<string, unknown> | undefined {
	const closers: string[] = [];
	let end = 0;
	let suffix = "";
	let pending = "";
	JSON_TOKEN.lastIndex = 0;
	for (let match = JSON_TOKEN.exec(text); match; match = JSON_TOKEN.exec(text)) {
		const token = match[0].trimStart();
		if (token === "{" || token === "[") closers.unshift(token === "{" ? "}" : "]");
		if ((token === "}" || token === "]") && closers.shift() !== token) break;
		if (token !== "," && token !== ":" && !(token.startsWith('"') && closers[0] === "}" && pending !== ":")) {
			end = JSON_TOKEN.lastIndex;
			suffix = closers.join("");
		}
		if (!closers.length) break;
		pending = token;
	}
	// Only top-level/error message prose may be partial. Quote completion here
	// cannot manufacture a quotaId, retryDelay or type from a cut string.
	if (CUT_MESSAGE.test(text.slice(end))) {
		const prose = parseJson(`${text}"${suffix}`);
		if (prose) return prose;
	}
	return parseJson(`${text.slice(0, end)}${suffix}`);
}

function parseBody(text: string): Record<string, unknown> {
	const start = text.indexOf("{");
	if (start < 0) return {};
	const body = text.slice(start);
	return parseJson(body) ?? recoverBody(body) ?? {};
}

function rpcSignals(body: Record<string, unknown>) {
	const error = record(body.error ?? body);
	const codes = [error.status, error.type, error.code].map(string);
	const quotaIds: string[] = [];
	const delays: string[] = [];
	for (const value of list(error.details)) {
		const detail = record(value);
		const type = string(detail["@type"]);
		if (/^(?:type\.googleapis\.com\/google\.rpc\.|google\.rpc\.)?QuotaFailure$/.test(type)) {
			for (const violation of list(detail.violations)) quotaIds.push(string(record(violation).quotaId));
		} else if (/^(?:type\.googleapis\.com\/google\.rpc\.|google\.rpc\.)?RetryInfo$/.test(type)) {
			delays.push(string(detail.retryDelay));
		} else if (/^(?:type\.googleapis\.com\/google\.rpc\.|google\.rpc\.)?ErrorInfo$/.test(type)) {
			codes.push(string(detail.reason));
			quotaIds.push(string(record(detail.metadata).quota_limit));
		}
	}
	return { status: error.code, codes, prose: string(error.message), quotaIds, delays };
}

function isNonQuotaStatus(status: unknown): boolean {
	return status === 401 || status === 403 || (typeof status === "number" && status >= 500 && status < 600);
}

function retryHint(delays: string[], prose: string): number | undefined {
	for (const delay of [
		...delays,
		...[...prose.matchAll(/\bretry in\s+((?:\d+(?:\.\d+)?[hms])+)(?!\w|\.\d)/gi)].map((match) => string(match[1])),
	]) {
		const parts = /^(?=\d)(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/i.exec(delay);
		if (!parts) continue;
		const ms = Number(parts[1] ?? 0) * 60 * MINUTE + Number(parts[2] ?? 0) * MINUTE + Number(parts[3] ?? 0) * SECOND;
		if (Number.isFinite(ms)) return ms;
	}
	return undefined;
}

/** Classify evidence, not marks. The caller owns repeat thresholds and caps the resulting expiry. */
export function classify(errorMessage: string | undefined, now: number): FailureClassification {
	const text = (errorMessage ?? "").trim();
	const leading = LEADING_STATUS.exec(text) ?? PREFIXED_STATUS.exec(text);
	const { status, codes, prose, quotaIds, delays } = rpcSignals(parseBody(text));
	const http = leading ? Number(leading[1]) : status;
	const prefix = string(text.split("{", 1)[0]);
	const message = `${prefix} ${prose}`.trim();
	const signal = [...codes, message].join(" ");
	const quota = { scope: "model", cause: "quota" } as const;
	// Negative evidence wins even when the message contains quota/billing words or a retry hint.
	if (
		isNonQuotaStatus(http) ||
		isNonQuotaStatus(status) ||
		NON_QUOTA_TYPE.test(signal) ||
		NON_QUOTA_CODE.test(signal) ||
		OVERLOAD.test(signal)
	) {
		return { class: "not-quota", scope: "model", cause: "other" };
	}
	if (http === 402 || BILLING.test(signal)) return { class: "billing", scope: "provider", cause: "billing" };
	const interactionsDaily = codes.includes("quota_exceeded") || message === "quota_exceeded";
	if (
		http === 429 ||
		VERDICT.test(signal) ||
		LEGACY_LIMIT.test(signal) ||
		LEGACY_LABEL.test(message) ||
		interactionsDaily
	) {
		const windows = quotaIds.join(" ");
		// The prose fallback accepts explicit window tokens, not arbitrary mentions of the word daily.
		if (PER_MINUTE.test(windows) || PER_MINUTE_TOKEN.test(message)) return { class: "per-minute", ...quota };
		if (interactionsDaily || DAILY.test(windows) || DAILY_TOKEN.test(message)) {
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
