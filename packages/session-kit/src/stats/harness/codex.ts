/**
 * Codex CLI rollouts: `<root>/sessions/YYYY/MM/DD/rollout-*.jsonl` and `<root>/archived_sessions/`.
 * `<root>` is `CODEX_HOME` or `~/.codex`.
 *
 * Reads four row types and ignores everything else:
 * - `session_meta`: thread ID, provider, and whether the thread is a spawned child
 * - `turn_context`: the model of a turn
 * - `token_usage_record`: per-response usage, joined to its model by `turn_id`
 * - `event_msg`/`token_count`: only `rate_limits`, the freshest quota reading
 *
 * `input_tokens` includes the cached (and cache-write) subset, so `input` is what is left after
 * subtracting both, keeping `input + output + cacheRead + cacheWrite` equal to Codex's own total.
 * Rollouts from before `token_usage_record` existed are skipped with a diagnostic, not approximated.
 * `history.jsonl`, `auth.json` and the SQLite databases are never opened. No cost is recorded.
 */

import { join } from "node:path";
import {
	asRecord,
	counters,
	entryHash,
	type HarnessScan,
	type QuotaObservation,
	sessionHash,
	str,
	windowName,
} from "./common.ts";
import { type HarnessCache, type ParsedFile, RowParser, scanJsonl } from "./scan.ts";

/** Router provider name for ChatGPT-plan quota, so Codex readings merge with `wham/usage`. */
const QUOTA_PROVIDER = "openai-codex";
const FALLBACK_PROVIDER = "openai";

interface Pending {
	ms: number;
	turnId: string;
	responseId: string;
	counts: number[];
}

class CodexParser extends RowParser {
	private provider = "";
	private readonly turnModels = new Map<string, string>();
	private readonly pending: Pending[] = [];
	private readonly quota = new Map<string, QuotaObservation>();
	private sawTokenCount = false;
	private records = 0;

	protected wanted(line: string): boolean {
		return ["session_meta", "turn_context", "token_usage_record", "token_count"].some((t) => line.includes(t));
	}

	protected row(row: Record<string, unknown>, ts: number): void {
		const payload = asRecord(row.payload) ?? {};
		if (row.type === "session_meta") {
			const id = str(payload.id);
			this.out.session ||= id && sessionHash("codex", id);
			this.out.child = str(payload.parent_thread_id) !== "";
			this.provider = str(payload.model_provider);
		} else if (row.type === "turn_context") {
			this.turnModels.set(str(payload.turn_id), str(payload.model));
		} else if (row.type === "token_usage_record") {
			this.usage(payload, ts);
		} else if (row.type === "event_msg" && payload.type === "token_count") {
			this.sawTokenCount = true;
			this.limits(asRecord(payload.rate_limits), ts);
		}
	}

	private usage(payload: Record<string, unknown>, ts: number): void {
		const usage = asRecord(payload.usage);
		const counts = counters([
			usage?.input_tokens,
			usage?.cached_input_tokens,
			usage?.cache_write_input_tokens,
			usage?.output_tokens,
		]);
		const [responseId, turnId] = [str(payload.response_id), str(payload.turn_id)];
		if (!counts || !responseId || !turnId || ts <= 0) {
			this.out.badLines++;
			return;
		}
		const [input, cached, written, output] = counts as [number, number, number, number];
		this.records++;
		this.seen(ts);
		this.pending.push({
			ms: ts,
			turnId,
			responseId,
			counts: [Math.max(0, input - cached - written), output, cached, written],
		});
	}

	private limits(limits: Record<string, unknown> | undefined, ts: number): void {
		const limitId = str(limits?.limit_id) || "codex";
		for (const slot of ["primary", "secondary"]) {
			const w = asRecord(limits?.[slot]);
			const [used, minutes, resets] = [w?.used_percent, w?.window_minutes, w?.resets_at];
			if (![used, minutes, resets].every((n) => typeof n === "number" && Number.isFinite(n)) || ts <= 0) continue;
			const window = windowName((minutes as number) * 60);
			const key = JSON.stringify([limitId, window]);
			const prev = this.quota.get(key);
			if (prev && prev.observedAt > ts) continue;
			this.quota.set(key, {
				harness: "codex",
				provider: QUOTA_PROVIDER,
				limitId,
				window,
				usedPercent: Math.min(100, Math.max(0, used as number)),
				resetAt: (resets as number) * 1000,
				durationMs: (minutes as number) * 60_000,
				observedAt: ts,
				planType: str(limits?.plan_type) || null,
			});
		}
	}

	override finish(): ParsedFile {
		this.out.quota = [...this.quota.values()];
		this.out.unsupported = this.sawTokenCount && this.records === 0;
		if (!this.out.session) {
			// Without `session_meta` there is no thread to attribute the usage to.
			this.out.badLines += this.pending.length;
			return this.out;
		}
		for (const p of this.pending) {
			const model = this.turnModels.get(p.turnId);
			if (!model) {
				this.out.badLines++;
				continue;
			}
			this.addCall(this.provider || FALLBACK_PROVIDER, model, p.ms, p.counts, 0, entryHash("codex", p.responseId));
		}
		return this.out;
	}
}

/** Read every Codex rollout under `root` (`CODEX_HOME`). A missing root is "not installed". */
export async function readCodex(root: string, cache: HarnessCache): Promise<HarnessScan> {
	return scanJsonl({
		harness: "codex",
		root,
		dirs: [join(root, "sessions"), join(root, "archived_sessions")],
		cache,
		parser: (_path, size, mtimeMs) => new CodexParser(size, mtimeMs),
	});
}
