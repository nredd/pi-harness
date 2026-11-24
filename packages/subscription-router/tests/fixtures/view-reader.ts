import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** One projected row: the label and gauge head the /stats reader derives from the view. */
export interface Row {
	label: string;
	head?: { kind: "gauge"; percent: number };
}
type Fields = Record<string, unknown>;
const list = (v: unknown): Fields[] => (Array.isArray(v) ? (v as Fields[]) : []);

/**
 * Minimal copy of the parse rules in session-kit's `src/stats/router-quota.ts`, kept here because a
 * package may not import another by relative path. `tests/fixtures/router-view.json` is byte-identical in
 * both packages (checked by scripts/tests/test_router_view_fixture.py) and session-kit's test feeds it to
 * the real reader, so drift in either side fails a test.
 */
export async function readRouterQuota(agentDir: string, now: number): Promise<Row[]> {
	const raw = await readFile(join(agentDir, "router-state", "v1", "view.json"), "utf8");
	const rows: Row[] = [];
	for (const view of list(JSON.parse(raw))) {
		const display = (view.display as Fields | undefined)?.full;
		const provider = typeof display === "string" ? display : String(view.provider);
		const snapshot = (view.snapshot ?? {}) as Fields;
		const old = snapshot.status === "stale" || (typeof snapshot.expiresAt === "number" && snapshot.expiresAt <= now);
		for (const w of list(snapshot.windows)) {
			if (typeof w.usedPercent === "number") {
				const span = w.spanSource === "assumed" || w.spanSource === "inferred" ? ` (${w.spanSource} span)` : "";
				rows.push({
					label: `${provider} ${w.name}${span}${old ? " (stale)" : ""}`,
					head: { kind: "gauge", percent: w.usedPercent },
				});
			}
		}
		for (const m of list(view.meters))
			if (Number(m.resetAt) > now || m.resetAt === undefined) rows.push({ label: `${provider} ${m.name}` });
		for (const p of list(view.pools)) rows.push({ label: `${provider} ${p.name}` });
		for (const k of list(view.marks)) if (Number(k.until) > now) rows.push({ label: `${provider} ${k.window}` });
	}
	return rows;
}
