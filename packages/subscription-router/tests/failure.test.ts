import { describe, expect, it } from "vitest";
import { classify, type FailureClassification, nextPacificMidnight } from "../src/failure.ts";

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
		["explicit spend window", rpc(quotaId("SpendPer10Minutes")), rolling],
		["spend without an explicit window", "429: Spend quota exceeded", unknown],
		[
			"per-minute window wins over daily and long retry",
			rpc(quotaId("RequestsPerDay", "TokensPerMinutePerProject"), retryDelay("95s")),
			perMinute,
		],
		["per-minute prose", "429: PerMinute, Please retry in 95s", perMinute],
		["long structured hint", `SDK error: ${rpc(retryDelay("95s"))}`, hinted],
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
		["billing in the JSON status position", '{"error":{"code":402,"message":"No funds"}}', billing],
		["502 overrides billing prose", "502: upstream failure checking billing", other],
		["503 overrides JSON quota evidence", `503: ${rpc(quotaId("PerDay"))}`, other],
		["overload without status", "overloaded: quota metrics unavailable", other],
		["network failure with stray status", "network error after 429 bytes", other],
		["connection reset with quota-looking wording", "ECONNRESET while checking billing", other],
		["safety overrides quota wording", "SAFETY: quota exceeded", other],
		["blocked overrides a 429", "429: response blocked, retry in 95s", other],
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
		["complete quotaId before cut", '429: {"error":{"details":[{"violations":[{"quotaId":"RequestsPerDay"', daily],
		["complete RetryInfo duration before cut", '{"error":{"code":429,"details":[{"retryDelay":"95s"', hinted],
		[
			"complete metadata limit before cut",
			'{"error":{"status":"RESOURCE_EXHAUSTED","metadata":{"quota_limit":"PerMinutePerProject"',
			perMinute,
		],
		["quoted Interactions code before cut", '{"error":{"code":"quota_exceeded"', daily],
		["cut inside quotaId", '429: {"error":{"details":[{"quotaId":"PerDay', unknown],
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

it.each([
	["2026-03-08T07:59:00Z", "2026-03-08T08:00:00Z"], // 23:59 PST before spring forward
	["2026-03-08T08:00:00Z", "2026-03-09T07:00:00Z"], // 23-hour day
	["2026-03-08T08:01:00Z", "2026-03-09T07:00:00Z"],
	["2026-11-01T06:59:00Z", "2026-11-01T07:00:00Z"], // 23:59 PDT before fall back
	["2026-11-01T07:00:00Z", "2026-11-02T08:00:00Z"], // 25-hour day
	["2026-11-01T07:01:00Z", "2026-11-02T08:00:00Z"],
	["2027-01-01T07:59:59.999Z", "2027-01-01T08:00:00.000Z"],
])("finds the next Pacific midnight for %s", (at, resetAt) => {
	expect(nextPacificMidnight(Date.parse(at))).toBe(Date.parse(resetAt));
});
