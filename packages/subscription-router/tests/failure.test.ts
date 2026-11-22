import { describe, expect, it } from "vitest";
import { classify, type FailureClassification, nextPacificMidnight } from "../src/failure.ts";
import { isQuotaError } from "../src/router.ts";

const NOW = Date.parse("2026-07-01T18:00:00Z");
const RESET = Date.parse("2026-07-02T07:00:00Z");
const quota = { scope: "model", cause: "quota" } as const;
const daily = { class: "daily", resetAt: RESET, ...quota } as const;
const rolling = { class: "rolling", resetAt: NOW + 600_000, ...quota } as const;
const perMinute = { class: "per-minute", ...quota } as const;
const hinted = { class: "hinted", hintMs: 95_000, ...quota } as const;
const unknown = { class: "unknown-quota", ...quota } as const;
const weak = { class: "weak", ...quota } as const;
const billing = { class: "billing", scope: "provider", cause: "billing" } as const;
const other = { class: "not-quota", scope: "model", cause: "other" } as const;

function rpc(...details: unknown[]): string {
	return JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", details } });
}

function quotaId(...ids: string[]) {
	return { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: ids.map((id) => ({ quotaId: id })) };
}

function retryDelay(delay: unknown) {
	return { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: delay };
}

it("takes the hint floor from the caller", () => {
	expect(classify("429: retry in 45s", NOW, 30_000)).toStrictEqual({ class: "hinted", hintMs: 45_000, ...quota });
	expect(classify("429: retry in 95s", NOW, 120_000)).toStrictEqual(perMinute);
});

describe("classify failure text", () => {
	it.each<[string, string | undefined, FailureClassification]>([
		[
			"daily quotaId in an SDK body",
			`429: ${rpc(quotaId("GenerateRequestsPerDayPerProject"), retryDelay("5s"))}`,
			daily,
		],
		[
			"daily ErrorInfo limit without an HTTP status",
			'{"error":{"details":[{"@type":"google.rpc.ErrorInfo","reason":"QUOTA_EXHAUSTED","metadata":{"quota_limit":"DailyRequests"}}]}}',
			daily,
		],
		["Interactions daily error code", '{"error":{"code":"quota_exceeded"}}', daily],
		["plain terminal code", "quota_exceeded", daily],
		["raw PerDay marker", "RESOURCE_EXHAUSTED: PerDay", daily],
		["raw Daily marker", "RESOURCE_EXHAUSTED: Daily", daily],
		["raw per day marker", "RESOURCE_EXHAUSTED: requests per day exhausted", daily],
		["raw RequestsPerDay marker", "RESOURCE_EXHAUSTED: RequestsPerDay", daily],
		["raw per minute beats daily", "RESOURCE_EXHAUSTED: PerDay and requests per minute", perMinute],
		["explicit spend window", rpc(quotaId("SpendPer10Minutes")), rolling],
		["spend without an explicit window", "429: Spend quota exceeded", unknown],
		[
			"per-minute window wins over daily and long retry",
			rpc(quotaId("RequestsPerDay", "TokensPerMinutePerProject"), retryDelay("95s")),
			perMinute,
		],
		["per-minute prose", "429: PerMinute, Please retry in 95s", perMinute],
		["long structured hint", `SDK error: ${rpc(retryDelay("95s"))}`, hinted],
		["bare google.rpc.RetryInfo", rpc({ "@type": "google.rpc.RetryInfo", retryDelay: "95s" }), hinted],
		["compound minute hint", rpc(retryDelay("1m35s")), hinted],
		[
			"hours, minutes and fractional seconds",
			rpc(retryDelay("1h2m3.5s")),
			{ class: "hinted", hintMs: 3_723_500, ...quota },
		],
		["hours only", rpc(retryDelay("2h")), { class: "hinted", hintMs: 7_200_000, ...quota }],
		["minute boundary", rpc(retryDelay("1m")), { class: "hinted", hintMs: 60_000, ...quota }],
		["decimal prose seconds", "429: retry in 95.2s", { class: "hinted", hintMs: 95_200, ...quota }],
		["compound prose hint", "429: retry in 1m35s.", hinted],
		["wrong unit order", rpc(retryDelay("35s1m")), unknown],
		["unrecognised duration", rpc(retryDelay("forever")), unknown],
		["prose with a nonsense duration suffix", "429: retry in 1m35secs", unknown],
		["decimal short hint", rpc(retryDelay("59.999s")), perMinute],
		["inclusive hint threshold", rpc(retryDelay("60s")), { class: "hinted", hintMs: 60_000, ...quota }],
		["decimal prose hint", "429: Please retry in 95.125s", { class: "hinted", hintMs: 95_125, ...quota }],
		["zero retry hint", "429: retry in 0s", perMinute],
		["bad delay followed by a good one", rpc(retryDelay(95), retryDelay("-15s"), retryDelay("95s")), hinted],
		["nonfinite duration", rpc(retryDelay(`${"9".repeat(309)}s`)), unknown],
		["HTTP retry header alone is not a text hint", "429: Retry-After: 95", unknown],
		["unattributed text hint alone", "retry in 95s", other],
		["bare status", " 429 ", unknown],
		["HTTP status line", "HTTP/1.1 429 Too Many Requests", unknown],
		["resource exhausted without 429", "RESOURCE_EXHAUSTED", unknown],
		[
			"new RPC body shape",
			'{"error":{"code":429,"details":[{"@type":"Unexpected","quotaId":"PerDay","retryDelay":"95s"}]}}',
			unknown,
		],
		[
			"JSON fields typed unexpectedly",
			rpc(
				null,
				{ "@type": "QuotaFailure", violations: [null, { quotaId: 4 }] },
				{ "@type": "ErrorInfo", metadata: null },
			),
			unknown,
		],
		["details field is not an array", '{"error":{"code":429,"details":{"quotaId":"PerDay"}}}', unknown],
		["non-scalar status is not coerced", '{"error":{"code":{"toString":null,"valueOf":null}}}', other],
		["ordinary daily wording does not imply a window", "429: Check the daily report", unknown],
		["bare 402", "402", billing],
		["credits depleted", "Credits depleted", billing],
		["prepayment credits", "No prepayment credits", billing],
		["billing wording", "billing account disabled", billing],
		["payment required", "Payment required", billing],
		["insufficient credits", "Insufficient credits for this request", billing],
		["insufficient balance", "insufficient balance", billing],
		["billing hard limit", "Billing hard limit has been reached", billing],
		["parenthesized 402", "OpenAI API error (402): No funds", billing],
		[
			"parenthesized 503 overrides billing prose",
			'OpenAI API error (503): {"error":{"message":"billing service failed"}}',
			other,
		],
		["parenthesized 401 overrides quota prose", "Mistral API error (401): quota project", other],
		["parenthesized 429 with a daily token", "Mistral API error (429): Daily quota exceeded", daily],
		["bare billing mention is weak", "400: Invalid billing address", weak],
		["billing limit without an affirmative verb is weak", "billing limit", weak],
		["billing in the JSON status position", '{"error":{"code":402,"message":"No funds"}}', billing],
		["502 overrides billing prose", "502: upstream failure checking billing", other],
		["503 overrides JSON quota evidence", `503: ${rpc(quotaId("PerDay"))}`, other],
		["overload without status", "overloaded: quota exceeded", other],
		["overload with underscore separator", "overloaded_error: quota exceeded", other],
		["overload with hyphen separator", "overloaded-error: quota exceeded", other],
		["overload after underscore separator", "server_overloaded: quota exceeded", other],
		["bare mixed-case overload", "Overloaded", other],
		["timeout with quota wording", "ETIMEDOUT: quota exceeded", other],
		["free-text network wording is not a transport error", "network error after 429 bytes", weak],
		["connection reset with quota-looking wording", "ECONNRESET while checking billing", other],
		["safety overrides quota wording", "SAFETY: quota exceeded", other],
		["free-text blocked does not override a 429", "429: response blocked, retry in 95s", hinted],
		["daily 429 mentioning blocked requests", "429: Daily quota exceeded; requests are blocked until reset", daily],
		["free-text unavailable does not override a 429", "429: quota temporarily unavailable", unknown],
		["free-text forbidden does not override a 429", "429: requests forbidden until reset", unknown],
		["free-text safety does not override a 429", "429: rate limit exceeded for platform safety", unknown],
		["free-text unauthorized does not override a 429", "429: unauthorized burst, rate limit exceeded", unknown],
		["gRPC UNAVAILABLE status overrides quota prose", '{"error":{"status":"UNAVAILABLE","message":"quota"}}', other],
		[
			"Anthropic authentication type overrides quota prose",
			'{"error":{"type":"authentication_error","message":"quota"}}',
			other,
		],
		["socket hang up with quota wording", "socket hang up: quota exceeded", other],
		["provider stop wrapper overrides a JSON body", `provider stopped with: ${rpc(quotaId("PerDay"))}`, other],
		["provider stop reason mentions quota", "Provider stopped with: quota exceeded", other],
		["401 overrides billing", "401: check billing", other],
		["403 overrides daily and quota", "403: quota exceeded (PerDay)", other],
		["JSON 403 overrides quota", '{"code":403,"status":"RESOURCE_EXHAUSTED"}', other],
		[
			"JSON auth overrides a conflicting transport 429",
			'429: {"error":{"code":403,"status":"RESOURCE_EXHAUSTED"}}',
			other,
		],
		["non-HTTP numeric code does not override quota", '{"error":{"code":1000,"status":"RESOURCE_EXHAUSTED"}}', unknown],
		["auth text without a status", "PERMISSION_DENIED: quota exceeded", other],
		["stray 429", "processed 429 tokens", weak],
		["leading token count", "429 tokens processed", weak],
		["stray 402", "processed 402 tokens", weak],
		["weak quota signal", "loaded quota metadata", weak],
		["weak rate-limit signal", "configured rate limit", weak],
		[
			"valid JSON cannot promote nested status-looking data",
			'{"telemetry":{"code":429},"message":"processed 429 tokens"}',
			weak,
		],
		["null error wrapper falls back to the top-level message", '{"error":null,"message":"quota metadata"}', weak],
		[
			"Anthropic rate-limit type",
			'{"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}',
			unknown,
		],
		["Anthropic extra usage", "Extra usage limit reached", unknown],
		["Anthropic balance", "Insufficient available balance", unknown],
		["Anthropic budget", "Out of budget", unknown],
		["Codex usage error", "UsageLimitError", unknown],
		["Codex shared subscription", "subscription_sharing_usage_limit_exceeded", unknown],
		["legacy insufficient quota code", "insufficient_quota", unknown],
		["ordinary failure", "failed to parse response", other],
		["absent error", undefined, other],
	])("%s", (_name, text, expected) => {
		expect(classify(text, NOW)).toStrictEqual(expected);
	});

	it.each<[string, string, FailureClassification]>([
		[
			"complete typed quotaId before cut",
			'429: {"error":{"details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaId":"RequestsPerDay"',
			daily,
		],
		[
			"complete typed quotaId survives a later cut inside another value",
			'429: {"details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaId":"RequestsPerDay","note":"cut',
			daily,
		],
		[
			"closed quotaId in unexpected detail",
			'429: {"error":{"details":[{"@type":"Unexpected","violations":[{"quotaId":"PerDay"',
			unknown,
		],
		[
			"closed quotaId before the detail type is known",
			'429: {"error":{"details":[{"violations":[{"quotaId":"PerDay"}],"@type":"cut',
			unknown,
		],
		[
			"known detail with quotaId at the wrong level",
			'429: {"details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","quotaId":"PerDay"',
			unknown,
		],
		[
			"foreign qualified detail named QuotaFailure",
			'429: {"details":[{"@type":"example.com/foreign.QuotaFailure","violations":[{"quotaId":"PerDay"',
			unknown,
		],
		[
			"explicit prose marker outside an unexpected detail",
			'429: {"error":{"message":"RequestsPerDay","details":[{"@type":"Unexpected","quotaId":"PerMinute"',
			daily,
		],
		["prose marker inside an unexpected detail", '429: {"details":[{"@type":"Unexpected","message":"PerDay"', unknown],
		[
			"complete typed RetryInfo duration before cut",
			'{"error":{"code":429,"details":[{"@type":"google.rpc.RetryInfo","retryDelay":"95s"',
			hinted,
		],
		[
			"complete typed metadata limit before cut",
			'{"error":{"status":"RESOURCE_EXHAUSTED","details":[{"@type":"google.rpc.ErrorInfo","metadata":{"quota_limit":"PerMinutePerProject"',
			perMinute,
		],
		["quoted Interactions code before cut", '{"error":{"code":"quota_exceeded"', daily],
		["cut inside quotaId", '429: {"error":{"details":[{"quotaId":"PerDay', unknown],
		["escaped final quote is not a closed quotaId", '429: {"quotaId":"PerDay\\"', unknown],
		[
			"escaped quote is not a closed quotaId even in a known detail",
			'429: {"details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaId":"PerDay\\"',
			unknown,
		],
		[
			"complete compound delay before cut",
			'429: {"details":[{"@type":"google.rpc.RetryInfo","retryDelay":"1m35s"',
			hinted,
		],
		["complete JSON followed by trailing text", '429: {"message":"PerDay"} trailing', daily],
		["mismatched detail container", '429: {"details":[{"quotaId":"PerDay"]', unknown],
		["unexpected token in a detail", '429: {"details":[oops,{"quotaId":"PerDay"', unknown],
		["invalid syntax cannot be recovered by closing containers", '429: {"code":429 "message":"PerDay"', unknown],
		["missing comma before a cut prose field", '429: {"flag":true "message":"PerDay', unknown],
		["cut before the status number is complete", '{"code":429.', other],
		["dangling escape", '429: {"message":"PerDay\\', unknown],
		["closed scalar before cut", '429: {"code":429,"flag":true,', unknown],
		["key cut after its closing quote", '429: {"message":"PerDay","details"', daily],
		["array ends before the cut", '429: {"message":"PerDay","details":[],', daily],
		["cut inside retryDelay", '429: {"retryDelay":"95s', unknown],
		["text hint in a cut-off message", '429: {"error":{"message":"Please retry in 95s. The quota', hinted],
		["safety in a cut-off message", '429: {"error":{"message":"SAFETY: quota exceeded', other],
		["truncated unknown shape", '{"error":{"code":429,"unknown":"PerDay"', unknown],
		["malformed JSON with 402", '{"error":{"code":402,oops}', billing],
		["malformed JSON with non-quota status", '{"error":{"code":503, oops, "message":"quota exceeded"}', other],
		["no HTTP or quota evidence survives", '{"error":{"code":42', other],
	])("%s", (_name, text, expected) => {
		expect(classify(text, NOW)).toStrictEqual(expected);
	});
});

// Distinct provider failure texts from router/exhaustion, policy compatibility/differential,
// and recovery (including the scenario and ownership fixtures). Keep those suites untouched.
const legacyFixtures = [
	"429 Too Many Requests",
	"429",
	"429 rate_limit_error",
	"429 rate limit",
	"429 Too Many Requests: rate_limit_error",
	"rate_limit_error",
	"insufficient_quota",
	"You exceeded your current quota exceeded",
	"insufficient_quota: You exceeded your current quota",
	"subscription_sharing_usage_limit_exceeded",
	"Your credit balance is too low; check billing",
	`400 {"type":"error","error":{"type":"invalid_request_error","message":"You're out of extra usage. Add more at claude.ai/settings/usage and keep going."}}`,
	"billing account disabled",
	"overloaded_error",
	"overloaded",
	"request took 4290ms",
	"invalid_api_key",
	"permission denied",
	"model_not_found",
	"network unreachable",
	"prompt is too long",
	"cancelled",
	undefined,
];

function legacyGate(errorMessage: string | undefined): boolean {
	return isQuotaError({ stopReason: "error", errorMessage });
}

function expectQuotaClass(text: string | undefined) {
	expect(["not-quota", "weak"], text).not.toContain(classify(text, NOW).class);
}

it.each(legacyFixtures)("preserves legacy quota evidence for fixture %s", (text) => {
	if (legacyGate(text)) expectQuotaClass(text);
});

// Witness each alternative of QUOTA_ERROR_PATTERN, including zero-width and single-character separators.
// Assert the gate as well as the classifier so removing a legacy match cannot silently skip parity.
it.each([
	"429",
	"quota",
	"rate limit",
	"rate-limit",
	"rate_limit",
	"ratelimit",
	"too many requests",
	"usage limit",
	"usage-limit",
	"usage_limit",
	"usagelimit",
	"out of budget",
	"extra usage",
	"extra-usage",
	"extra_usage",
	"extrausage",
	"available balance",
	"UsageLimitError",
	"subscription_sharing_usage_limit_exceeded",
])("preserves the legacy gate phrase %s", (text) => {
	expect(legacyGate(text)).toBe(true);
	expectQuotaClass(text);
});

// A bare billing mention still passes the gate, but it is weak: S15, never read or marked.
it.each(["billing", "billing limit"])("keeps the legacy gate for the billing mention %s as weak evidence", (text) => {
	expect(legacyGate(text)).toBe(true);
	expect(classify(text, NOW)).toStrictEqual(weak);
});

it.each([
	["2026-03-08T07:59:00Z", "2026-03-08T08:00:00Z"], // 23:59 PST before spring forward
	["2026-03-08T08:00:00Z", "2026-03-09T07:00:00Z"], // 23-hour day
	["2026-03-08T08:01:00Z", "2026-03-09T07:00:00Z"],
	["2026-03-08T09:59:00Z", "2026-03-09T07:00:00Z"], // 01:59 PST
	["2026-03-08T10:01:00Z", "2026-03-09T07:00:00Z"], // 03:01 PDT
	["2026-11-01T06:59:00Z", "2026-11-01T07:00:00Z"], // 23:59 PDT before fall back
	["2026-11-01T07:00:00Z", "2026-11-02T08:00:00Z"], // 25-hour day
	["2026-11-01T07:01:00Z", "2026-11-02T08:00:00Z"],
	["2026-11-01T07:59:00Z", "2026-11-02T08:00:00Z"], // 00:59 PDT
	["2026-11-01T08:59:00Z", "2026-11-02T08:00:00Z"], // 01:59 PDT
	["2026-11-01T09:59:00Z", "2026-11-02T08:00:00Z"], // 01:59 PST (repeated hour)
	["2026-11-01T10:01:00Z", "2026-11-02T08:00:00Z"], // 02:01 PST
	["2027-01-01T07:59:59.999Z", "2027-01-01T08:00:00.000Z"],
])("finds the next Pacific midnight for %s", (at, resetAt) => {
	const now = Date.parse(at);
	const expected = Date.parse(resetAt);
	expect(nextPacificMidnight(now)).toBe(expected);
	expect(classify("RESOURCE_EXHAUSTED: Daily", now)).toStrictEqual({ ...daily, resetAt: expected });
});

// Core's `formatProviderError` prefixes are `<provider> API error (<status>): ` plus the
// `OpenAI Decisions error` and `llama.cpp error` labels. Any other parenthesized number is prose
// and never outranks the body's structured status.
it.each<[string, string, FailureClassification]>([
	["free-prefix 402 is not a status", "Request ID (402): malformed input", weak],
	[
		"free-prefix 503 cannot veto a JSON daily 429",
		'Shard (503): {"error":{"code":429,"message":"Daily quota exceeded"}}',
		daily,
	],
	["free-prefix 401 is not a status", "Tenant (401): quota exceeded", unknown],
	["core provider prefix 429", "google-vertex API error (429): Daily quota exceeded", daily],
	["core provider prefix 503", "Azure OpenAI API error (503): quota exceeded", other],
	["OpenAI Decisions 429", "OpenAI Decisions error (429): Daily limit reached", daily],
	["OpenAI Decisions 503", "OpenAI Decisions error (503): Daily quota exceeded", other],
	["llama.cpp 429", "llama.cpp error (429): Daily limit reached", daily],
	["llama.cpp 503", "llama.cpp error (503): Daily quota exceeded", other],
	["System One API 503", "System One API error (503): Daily quota exceeded", other],
	["unknown label error prefix 503", "Gateway error (503): Daily quota exceeded", daily],
])("reads statuses only from core wrappers: %s", (_name, text, expected) => {
	expect(classify(text, NOW)).toStrictEqual(expected);
});

// Billing needs a 402, a billing error code or affirmative payment wording of the provider's own.
it.each<[string, string, FailureClassification]>([
	["quoted single-quoted enum value", "400: Invalid enum value 'insufficient credits'", other],
	["quoted double-quoted value", '400: Invalid value "payment required" for field tier', other],
	[
		"unquoted validation of a 4xx",
		"422: Validation failed: plan must be one of free, pro; got insufficient credits",
		other,
	],
	["billing error code", '{"error":{"code":"billing_hard_limit_reached","message":"Limit reached"}}', billing],
	["apostrophes are not quotes", "You're out of credits. Credits depleted, top up", billing],
	[
		"Anthropic 400 credit balance",
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
		billing,
	],
])("requires affirmative billing evidence: %s", (_name, text, expected) => {
	expect(classify(text, NOW)).toStrictEqual(expected);
});

// S5: an error type vetoes only from a structured field or the verdict position at the start of
// the message, never from an uppercase word inside a genuine quota message.
it.each<[string, string, FailureClassification]>([
	[
		"UNAVAILABLE inside a daily 429 body",
		'429: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Daily quota exceeded. Model UNAVAILABLE until reset."}}',
		daily,
	],
	["PERMISSION_DENIED inside daily prose", "429: Daily quota exceeded, PERMISSION_DENIED for new requests", daily],
	["SAFETY after the status", "429: SAFETY: quota exceeded", other],
	["UNAVAILABLE as a structured reason", rpc({ "@type": "google.rpc.ErrorInfo", reason: "UNAVAILABLE" }), other],
])("matches non-quota types in verdict positions only: %s", (_name, text, expected) => {
	expect(classify(text, NOW)).toStrictEqual(expected);
});

// S7: per-minute never marks, so explicit per-minute evidence beats billing and daily wording.
it.each<[string, string, FailureClassification]>([
	[
		"billing wording with a PerMinute quotaId",
		`429: ${JSON.stringify({ error: { code: 429, message: "Insufficient credits", details: [quotaId("RequestsPerMinute")] } })}`,
		perMinute,
	],
	["credits depleted for a per-minute window", "Credits depleted for RequestsPerMinute", perMinute],
	["402 naming a per-minute window", "402: payment required, PerMinute", perMinute],
	["daily wording with a per-minute token", "429: Daily quota exceeded (RequestsPerMinute)", perMinute],
	["402 with a quoted PerMinute plan", '402: payment required for plan "PerMinute"', billing],
	["402 with a single-quoted per-minute value", "402: payment required for tier 'RequestsPerMinute'", billing],
	["429 quoting a per-minute metric stays a throttle", "429: Quota exceeded for metric 'RequestsPerMinute'", perMinute],
])("lets explicit per-minute evidence win: %s", (_name, text, expected) => {
	expect(classify(text, NOW)).toStrictEqual(expected);
});

// Core-generated quota messages are verdicts, not weak gate matches: S15 never reads or marks weak.
it.each([
	"You have hit your ChatGPT usage limit (plus plan). Try again in ~158 min.",
	"You have hit your ChatGPT usage limit.",
	"You exceeded your current quota, please check your plan and billing details.",
	"Monthly usage limit reached",
	"GoUsageLimitError",
	"FreeUsageLimitError",
])("treats the core quota message %s as quota evidence", (text) => {
	expect(classify(text, NOW)).toStrictEqual(unknown);
	expect(legacyGate(text)).toBe(true);
});

// Anthropic subscription window exhaustion arrives as statusless stream-error prose. It is a quota
// verdict of unknown shape: it reaches the read, and infers only on the repeat threshold (S8).
it.each([
	"You have reached your weekly usage limit",
	"You've reached your weekly usage limit. Resets Monday 9am",
	"5-hour limit reached, resets 3pm",
	"Five-hour usage limit reached",
	"You've hit your session limit",
	"Weekly limit exceeded",
	"Claude AI usage limit reached|1750000000",
	"You have hit your usage limit.",
])("treats the window exhaustion %s as quota evidence", (text) => {
	expect(classify(text, NOW)).toStrictEqual(unknown);
	expect(legacyGate(text)).toBe(true);
});

it.each([
	"You have not reached your weekly usage limit",
	"You haven't hit your usage limit yet",
	"weekly usage limit: 40% used",
])("keeps non-affirmative window wording %s weak", (text) => {
	expect(classify(text, NOW)).toStrictEqual(weak);
});
