/** Offline provenance display. Export time is not last activity or proof of fleet completeness. */
import { sanitize } from "../diff/view.ts";
import { HARNESSES } from "./load.ts";
import type { Coverage, HarnessStatus } from "./snapshot.ts";

/** Invalid/absent clocks never become fresh; future clocks are explicitly untrustworthy. */
export function timestampLabel(ms: number | undefined, now: number): string {
	if (ms === undefined || !Number.isFinite(ms) || ms <= 0 || ms > 8640000000000000) return "unknown";
	const timestamp = new Date(ms).toISOString();
	if (ms > now) return `${timestamp} (future; clock skew)`;
	const minutes = Math.floor((now - ms) / 60000);
	const age =
		minutes < 1
			? "<1m"
			: minutes < 60
				? `${minutes}m`
				: minutes < 1440
					? `${Math.floor(minutes / 60)}h`
					: `${Math.floor(minutes / 1440)}d`;
	return `${timestamp} (${age} ago)`;
}

/** One harness on one machine: found or not installed, last event, last clean read, diagnostics. */
function harnessLine(name: string, status: HarnessStatus, now: number): string {
	const parts: string[] = [];
	if (status.found !== undefined) parts.push(status.found ? "found" : "not installed");
	if (status.lastGoodAt !== undefined)
		parts.push(
			`${status.stale ? "STALE, not read cleanly since" : "last read cleanly"} ${timestampLabel(status.lastGoodAt, now)}`,
		);
	if (status.lastEventMs !== undefined) parts.push(`last event ${timestampLabel(status.lastEventMs, now)}`);
	for (const problem of status.problems) parts.push(sanitize(problem.replace(/^[a-z]+: /, "")));
	return `  ${name}: ${parts.join(" · ") || "no data"}`;
}

/** Shared print/TUI lines. UUIDs disambiguate default or duplicate labels without exposing hostnames. */
export function freshnessLines(coverage: Coverage, now = Date.now()): string[] {
	const lines = [
		`Viewer last import: ${timestampLabel(coverage.importedAt, now)}`,
		"Known sources only; other machines cannot be discovered here.",
		"Export age is not last activity. Local history is scanned on opening.",
	];
	if (!coverage.sources?.length) return [...lines, "Per-machine freshness unknown (no source metadata)."];
	for (const source of [...coverage.sources].sort(
		(a, b) => Number(b.local) - Number(a.local) || a.machineId.localeCompare(b.machineId),
	)) {
		lines.push("", `${sanitize(source.label)} [${source.machineId}]${source.local ? " (local)" : ""}`);
		if (source.local) lines.push(source.incomplete ? "Local scan incomplete" : "Local scan complete at opening");
		else {
			lines.push(`Producer exported: ${timestampLabel(source.exportedAt, now)}`);
			if (source.incomplete)
				lines.push(
					source.exportedAt === undefined
						? "Incomplete import; no last-good snapshot"
						: "Incomplete import; retained last-good snapshot",
				);
		}
		for (const h of HARNESSES) {
			const status = source.harnesses?.[h];
			if (status) lines.push(harnessLine(h, status, now));
		}
	}
	return lines;
}
