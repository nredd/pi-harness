/**
 * Hand-written, synthetic transcripts mirroring the shapes the readers parse. Every content, cwd,
 * title and directory-name field carries a CANARY: privacy tests fail if any reaches reader output.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const CANARY = "CANARY-7f3a91";

export function writeLines(path: string, lines: unknown[]): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`);
}

export interface ClaudeRow {
	id?: string;
	requestId?: string;
	sessionId?: string;
	ts?: string;
	model?: string;
	usage?: Record<string, unknown>;
	isSidechain?: boolean;
	block?: string;
}

export function claudeRow({
	id = "msg_1",
	requestId = "req_1",
	sessionId = "sess-A",
	ts = "2026-10-01T12:00:00.000Z",
	model = "claude-opus-5-5",
	usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
	isSidechain = false,
	block = "text",
}: ClaudeRow = {}): Record<string, unknown> {
	return {
		type: "assistant",
		uuid: `uuid-${Math.random()}`,
		sessionId,
		requestId,
		timestamp: ts,
		cwd: `/Users/${CANARY}/work`,
		gitBranch: `${CANARY}-branch`,
		isSidechain,
		message: {
			id,
			role: "assistant",
			model,
			content: [
				block === "text" ? { type: "text", text: `${CANARY} text` } : { type: "tool_use", input: { path: CANARY } },
			],
			usage,
		},
	};
}

export const claudeUser = (): Record<string, unknown> => ({
	type: "user",
	sessionId: "sess-A",
	timestamp: "2026-10-01T11:59:00.000Z",
	message: { role: "user", content: `${CANARY} the assistant should do it` },
});

export interface CodexTurn {
	turn?: string;
	model?: string;
	response?: string;
	ts?: string;
	usage?: Record<string, unknown>;
}

export const codexMeta = (id = "thread-1", extra: Record<string, unknown> = {}): Record<string, unknown> => ({
	timestamp: "2026-10-02T10:00:00.000Z",
	type: "session_meta",
	payload: {
		id,
		cwd: `/Users/${CANARY}/repo`,
		model_provider: "openai",
		creator_account_id: `${CANARY}-account`,
		base_instructions: { text: CANARY },
		...extra,
	},
});

export const codexContext = (turn = "turn-1", model = "gpt-6.1-sol"): Record<string, unknown> => ({
	timestamp: "2026-10-02T10:00:01.000Z",
	type: "turn_context",
	payload: { turn_id: turn, cwd: `/Users/${CANARY}/repo`, model },
});

export const codexRecord = ({
	turn = "turn-1",
	response = "resp-1",
	ts = "2026-10-02T10:00:02.000Z",
	usage = { input_tokens: 1000, cached_input_tokens: 800, cache_write_input_tokens: 0, output_tokens: 50 },
}: CodexTurn = {}): Record<string, unknown> => ({
	timestamp: ts,
	type: "token_usage_record",
	payload: { thread_id: "thread-1", turn_id: turn, session_id: "s", response_id: response, usage },
});

export const codexTokenCount = (rateLimits: unknown, ts = "2026-10-02T10:00:03.000Z"): Record<string, unknown> => ({
	timestamp: ts,
	type: "event_msg",
	payload: {
		type: "token_count",
		info: { last_token_usage: { input_tokens: 1000 } },
		rate_limits: rateLimits,
	},
});

export const codexMessage = (): Record<string, unknown> => ({
	timestamp: "2026-10-02T10:00:04.000Z",
	type: "response_item",
	payload: { type: "message", content: [{ type: "output_text", text: `${CANARY} session_meta` }] },
});

export const limits = (
	primary: Record<string, unknown> | null,
	secondary: Record<string, unknown> | null = null,
	extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
	limit_id: "codex",
	plan_type: "pro",
	primary,
	secondary,
	credits: { has_credits: true, balance: `${CANARY}` },
	...extra,
});
