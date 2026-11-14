/**
 * Codex CLI rollouts: `<root>/sessions/YYYY/MM/DD/rollout-*.jsonl` and `<root>/archived_sessions/`.
 * `<root>` is `CODEX_HOME` or `~/.codex`.
 *
 * Reads four row types and ignores everything else:
 * - `session_meta`: thread ID, provider, the account ID (only as a salted hash, see `accountHash`, and
 *   only to keep two accounts' quota apart; no account dimension on usage) and whether the thread is a spawned child (`parent_thread_id`
 *   or `agent_path`); only the first one in a file counts
 * - `turn_context`: the model of a turn
 * - `token_usage_record`: per-response usage, joined to its model by `turn_id`
 * - `event_msg`/`token_count`: only `rate_limits`, the freshest quota reading
 *
 * `input_tokens` includes the cached (and cache-write) subset, so `input` is what is left after
 * subtracting both, keeping `input + output + cacheRead + cacheWrite` equal to Codex's own total.
 * Turns that only have a `token_count` with usage info (before `token_usage_record` existed, including
 * old turns in a rollout later resumed on a newer Codex) are counted and reported, not approximated.
 * `history.jsonl`, `auth.json` and the SQLite databases are never opened. No cost is recorded.
 */

import { join } from "node:path";
import {
	accountHash,
	anyPresent,
	asRecord,
	asRecordOf,
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
	constructor(size: number, mtimeMs: number, salt: string) {
		super(size, mtimeMs);
		this.salt = salt;
	}

	private provider = "";
	private account = "";
	private readonly salt: string;
	private readonly turnModels = new Map<string, string>();
	private readonly pending: Pending[] = [];
	private readonly quota = new Map<string, QuotaObservation>();
	private currentTurn = "";
	private readonly countedTurns = new Set<string>();
	private readonly recordedTurns = new Set<string>();

	protected wanted(line: string): boolean {
		return ["session_meta", "turn_context", "token_usage_record", "token_count"].some((t) => line.includes(t));
	}

	protected row(row: Record<string, unknown>, ts: number): void {
		const payload = asRecordOf(row.payload);
		if (row.type === "session_meta") {
			// The first meta names the thread; a replayed parent meta later in a fork must not rewrite it.
			const id = str(payload.id);
			if (id && !this.out.session) {
				this.out.session = sessionHash("codex", id);
				this.out.child = str(payload.parent_thread_id) !== "" || str(payload.agent_path) !== "";
				this.provider = str(payload.model_provider);
				const account = str(payload.creator_account_id);
				this.account = account ? accountHash(this.salt, "codex", account) : "";
			}
		} else if (row.type === "turn_context") {
			this.currentTurn = str(payload.turn_id);
			this.turnModels.set(this.currentTurn, str(payload.model));
		} else if (row.type === "token_usage_record") {
			this.usage(payload, ts);
		} else if (row.type === "event_msg" && payload.type === "token_count") {
			if (asRecord(payload.info)) this.countedTurns.add(this.currentTurn);
			this.limits(asRecord(payload.rate_limits), ts);
		}
	}

	private usage(payload: Record<string, unknown>, ts: number): void {
		this.recordedTurns.add(str(payload.turn_id));
		const usage = asRecord(payload.usage);
		const raw = [
			usage?.input_tokens,
			usage?.cached_input_tokens,
			usage?.cache_write_input_tokens,
			usage?.output_tokens,
		];
		const counts = counters(raw);
		const [responseId, turnId] = [str(payload.response_id), str(payload.turn_id)];
		if (!counts || !anyPresent(raw) || !responseId || !turnId || ts <= 0) {
			this.out.badLines++;
			return;
		}
		const [input, cached, written, output] = counts as [number, number, number, number];
		if (input + output === 0) return;
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
			// Per reset time, not per window: whether a reading is still live depends on a clock the cache does
			// not have, so a newer already-reset reading must not discard an older live one.
			const key = JSON.stringify([limitId, window, this.account, resets]);
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
				account: this.account,
			});
		}
	}

	override finish(): ParsedFile {
		this.out.quota = [...this.quota.values()];
		this.out.unsupportedTurns = [...this.countedTurns].filter((t) => !this.recordedTurns.has(t)).length;
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
			this.addCall(this.provider || FALLBACK_PROVIDER, model, p.ms, p.counts, null, entryHash("codex", p.responseId));
		}
		return this.out;
	}
}

/**
 * Read every Codex rollout under `root` (`CODEX_HOME`). A missing root is "not installed". `salt` is the
 * installation's secret: it keys the account discriminator on quota readings.
 */
export async function readCodex(root: string, cache: HarnessCache, salt: string): Promise<HarnessScan> {
	return scanJsonl({
		harness: "codex",
		root,
		dirs: [join(root, "sessions"), join(root, "archived_sessions")],
		cache,
		parser: (_path, size, mtimeMs) => new CodexParser(size, mtimeMs, salt),
	});
}
