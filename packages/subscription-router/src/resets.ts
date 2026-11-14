/** Cached schedule interpretation only. This module never redeems grants or changes admission. */
import type { UsageSnapshot, UsageWindow } from "./usage.js";

/** Official interactive handoff, not a shell command or a programmatic redemption API. */
export const CODEX_RESET_HELP = "https://help.openai.com/en/articles/20001498-how-resets-work-in-codex";

/** Date validity includes the JavaScript Date range, not just finite numbers. */
function validTime(value: number | undefined): value is number {
	return value !== undefined && Number.isFinite(new Date(value).getTime());
}

/** Local calendar time with an explicit zone/offset, and the authoritative UTC instant. */
function instant(value: number | undefined, timeZone: string): string {
	if (!validTime(value)) return "unknown";
	const local = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
		timeZoneName: "longOffset",
	}).format(value);
	return `${local} [${timeZone}]; UTC ${new Date(value).toISOString()}`;
}

/** Relative timing is descriptive, never evidence that quota replenished. */
function relative(value: number, now: number): string {
	const minutes = Math.ceil(Math.abs(value - now) / 60_000);
	return value > now ? `in ${minutes}m` : `${minutes}m ago; reset passed; needs verification`;
}

/** Never label a guessed positional span as provider-reported. */
function span(window: UsageWindow): string {
	const ms = window.durationMs;
	if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return "unknown";
	const duration =
		ms % 86_400_000 === 0 ? `${ms / 86_400_000}d` : ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : `${ms / 1000}s`;
	return `${duration} (${window.spanSource ?? "provenance unknown"})`;
}

/** Render the same cached view for native Pi UI and non-TUI transcripts; no credential or network access. */
export function formatResets(
	providers: readonly string[],
	peek: (provider: string) => UsageSnapshot | undefined,
	now: number,
	timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
	const lines = ["Scheduled replenishment (cached, not banked reset offers):"];
	if (providers.length === 0) lines.push("No subscription providers in use.");
	for (const provider of providers) {
		const snapshot = peek(provider);
		if (!snapshot) {
			lines.push(`${provider}: unknown (not checked); last checked: unknown`);
			continue;
		}
		const state = snapshot.status === "available" ? (snapshot.expiresAt > now ? "fresh" : "stale") : snapshot.status;
		lines.push(`${provider}: ${state}; last checked: ${instant(snapshot.retrievedAt, timeZone)}`);
		if (snapshot.message) lines.push(`  ${snapshot.message}`);
		if (snapshot.windows.length === 0) lines.push("  No scheduled windows reported; capacity unknown.");
		for (const window of snapshot.windows) {
			const scope =
				window.scope === "provider" ? "all provider models" : `families: ${window.families?.join(", ") || "unknown"}`;
			lines.push(`  ${window.name}: ${window.usedPercent}% used; ${scope}; span: ${span(window)}`);
			lines.push(
				`    reset: ${instant(window.resetAt, timeZone)}${validTime(window.resetAt) ? ` (${relative(window.resetAt, now)})` : ""}`,
			);
		}
	}
	lines.push(
		"Schedule inspection: supported by usage collectors; freshness/availability shown above.",
		"Codex banked FREE resets:",
		"  Offer discovery: /router resets codex (explicit account-bound read, verified client required).",
		"  Free redemption: supported only after grant selection and explicit human confirmation there.",
		"  Balance, eligibility, expiry and history: unknown, not verified zero.",
		"  Capability/version/auth failures are reported explicitly; no separate CLI account or private HTTP fallback is used.",
		"  Official handoff: in Codex CLI use /usage -> Redeem reset; if absent, use desktop Settings > Usage & billing or web Usage settings.",
		"  Check the account/workspace, covered allowances and expiry there before confirming a FREE banked reset. Do not select Buy an instant reset.",
		`  ${CODEX_RESET_HELP}`,
		"Paid purchases and extra usage billing are excluded. No automatic redemption.",
		"/router reset clears LOCAL confirmed blocks only; it does not reset provider quota.",
		"Refresh: explicit read-only usage check, at most once/minute/provider; shared cache, timeout and failure backoff still apply.",
	);
	return lines.join("\n");
}
