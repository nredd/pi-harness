/** A synthetic HOME holding one Claude, one Codex and one OpenCode record, each with canaries. */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	CANARY,
	claudeRow,
	codexContext,
	codexMessage,
	codexMeta,
	codexRecord,
	codexTokenCount,
	limits,
	writeLines,
} from "./fixtures.ts";

export const OPENCODE_MS = Date.parse("2026-10-03T09:00:00Z");
/** Reset time of the Codex weekly window, epoch seconds. */
export const CODEX_RESET_S = 1_790_000_000;

/** Write the three harnesses' data under `home`; returns the roots a producer would use. */
export function seedHarnessHome(home: string): { claude: string; codex: string; opencode: string } {
	const claude = join(home, ".claude");
	writeLines(join(claude, "projects", `-Users-${CANARY}-work`, "sess-A.jsonl"), [
		claudeRow({ id: "msg_1", requestId: "req_1" }),
		claudeRow({ id: "msg_1", requestId: "req_1", block: "tool" }),
	]);
	// Credential and prompt files exist beside the transcripts and must never be read.
	writeLines(join(claude, ".credentials.json"), [{ token: CANARY }]);
	const codex = join(home, ".codex");
	writeLines(join(codex, "sessions", "2026", "10", "02", "rollout-a.jsonl"), [
		codexMeta(),
		codexContext("turn-1", "gpt-6.1-sol"),
		codexMessage(),
		codexRecord({ turn: "turn-1", response: "resp-1" }),
		codexTokenCount(limits({ used_percent: 12.5, window_minutes: 10080, resets_at: CODEX_RESET_S })),
	]);
	writeLines(join(codex, "auth.json"), [{ access_token: CANARY }]);
	writeLines(join(codex, "history.jsonl"), [{ text: CANARY }]);
	const opencode = join(home, ".local", "share", "opencode", "opencode.db");
	mkdirSync(join(opencode, ".."), { recursive: true });
	const db = new DatabaseSync(opencode);
	try {
		db.exec(`
			CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);
			CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
		`);
		db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)").run(
			"ses_1",
			null,
			`${CANARY} title`,
			`/Users/<user>/${CANARY}`,
			OPENCODE_MS,
			OPENCODE_MS,
		);
		db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
			"msg_oc",
			"ses_1",
			OPENCODE_MS,
			JSON.stringify({
				role: "assistant",
				providerID: "anthropic",
				modelID: "claude-opus-5-5",
				cost: 0.25,
				tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 30, write: 40 } },
				summary: `${CANARY} text`,
			}),
		);
	} finally {
		db.close();
	}
	return { claude, codex, opencode };
}

let bumps = 0;
/** Change the OpenCode database without changing what it reports: a non-assistant row, so the cache stamp moves. */
export function bumpOpenCode(dbPath: string): void {
	const db = new DatabaseSync(dbPath);
	try {
		db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
			`bump_${bumps++}`,
			"ses_1",
			OPENCODE_MS,
			'{"role":"user"}',
		);
	} finally {
		db.close();
	}
}
