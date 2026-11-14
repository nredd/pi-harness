/**
 * Claude Code transcripts: `<root>/projects/<encoded cwd>/<session>.jsonl`, plus
 * `<session>/subagents/agent-*.jsonl`. `<root>` is `CLAUDE_CONFIG_DIR` or `~/.claude`.
 *
 * Only `type: "assistant"` rows are read, and only their model, usage counters, timestamp and the
 * IDs that identify the response. One API response is written once per content block with the same
 * usage, so rows collapse by `(message.id, requestId)` (see `flatten`). Project directory names
 * encode the cwd: they appear only in the local cache's path keys (never in a result, cached
 * value, diagnostic or snapshot). Cost is not recorded per message.
 * `stats-cache.json`, `.credentials.json` and everything else under the root is never opened.
 */

import { basename, join, sep } from "node:path";
import { asRecord, counters, entryHash, type HarnessScan, sessionHash, str } from "./common.ts";
import { type HarnessCache, RowParser, scanJsonl } from "./scan.ts";

/** Responses made by the CLI itself, not a model. */
const SYNTHETIC_MODEL = "<synthetic>";

class ClaudeParser extends RowParser {
	private readonly agent: string | null;

	constructor(size: number, mtimeMs: number, agent: string | null) {
		super(size, mtimeMs);
		this.agent = agent;
		this.out.child = agent !== null;
	}

	protected wanted(line: string): boolean {
		return line.includes('"assistant"');
	}

	protected row(row: Record<string, unknown>, ts: number): void {
		if (row.type !== "assistant") return;
		const message = asRecord(row.message);
		const usage = asRecord(message?.usage);
		const model = str(message?.model);
		if (!usage || !model || model === SYNTHETIC_MODEL) return;
		const counts = counters([
			usage.input_tokens,
			usage.output_tokens,
			usage.cache_read_input_tokens,
			usage.cache_creation_input_tokens,
		]);
		if (!counts) {
			this.out.badLines++;
			return;
		}
		if (counts.every((n) => n === 0)) return;
		const [id, requestId, sessionId] = [str(message?.id), str(row.requestId), str(row.sessionId)];
		if (!id || !requestId || !sessionId || ts <= 0) {
			this.out.badLines++;
			return;
		}
		this.seen(ts);
		// A subagent file shares its parent's `sessionId`; give it its own session so it is flagged as a
		// child without turning the parent into one.
		this.out.session ||= sessionHash("claude", this.agent === null ? sessionId : `${sessionId}#${this.agent}`);
		this.addCall("anthropic", model, ts, counts, 0, entryHash("claude", JSON.stringify([id, requestId])));
	}
}

/** `agent-<id>` for a file under a `subagents/` directory, else null. */
const agentOf = (path: string): string | null =>
	path.split(sep).at(-2) === "subagents" ? basename(path, ".jsonl") : null;

/** Read every Claude Code transcript under `root` (the config dir). A missing root is "not installed". */
export async function readClaude(root: string, cache: HarnessCache): Promise<HarnessScan> {
	return scanJsonl({
		harness: "claude",
		root,
		dirs: [join(root, "projects")],
		cache,
		parser: (path, size, mtimeMs) => new ClaudeParser(size, mtimeMs, agentOf(path)),
	});
}
