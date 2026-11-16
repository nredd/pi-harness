/** Optional statusLine capture adapter. Only named numeric quota survives; capture failures are silent. */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { asRecord, type QuotaObservation } from "./common.ts";

/** Read fresh file contents on every scan, independently of the transcript cache and its diagnostics. */
export async function readClaudeQuota(root: string, now = Date.now()): Promise<QuotaObservation[]> {
	try {
		const path = join(root, "rate-limits.json");
		const info = await stat(path);
		if (!info.isFile() || info.size > 65_536) return [];
		const doc = asRecord(JSON.parse(await readFile(path, "utf8")));
		const observed = doc?.observed_at;
		if (typeof observed !== "number" || !Number.isFinite(observed) || observed <= 0 || observed * 1000 > now) return [];
		const limits = asRecord(doc?.rate_limits);
		const out: QuotaObservation[] = [];
		for (const [name, window, durationMs] of [
			["five_hour", "5h", 18_000_000],
			["seven_day", "7d", 604_800_000],
		] as const) {
			const value = asRecord(limits?.[name]);
			const used = value?.used_percentage;
			const reset = value?.resets_at;
			if (
				typeof used !== "number" ||
				!Number.isFinite(used) ||
				used < 0 ||
				used > 100 ||
				typeof reset !== "number" ||
				!Number.isSafeInteger(reset) ||
				reset <= 0 ||
				!Number.isSafeInteger(reset * 1000)
			)
				continue;
			out.push({
				harness: "claude",
				provider: "anthropic",
				limitId: "anthropic",
				window,
				usedPercent: used,
				resetAt: reset * 1000,
				durationMs,
				observedAt: observed * 1000,
				planType: null,
				account: "",
			});
		}
		return out;
	} catch {
		// Missing, malformed or unreadable optional capture must never invalidate transcript history.
		return [];
	}
}
