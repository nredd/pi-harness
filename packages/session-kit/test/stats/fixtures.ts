import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Call } from "../../src/stats/load.ts";

/** Local-time instant for `YYYY-MM-DD` at `hour`. */
export function at(day: string, hour = 12): number {
	const [y, m, d] = day.split("-").map(Number);
	return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, hour).getTime();
}

export function call(
	day: string,
	provider: string,
	model: string,
	input: number,
	output = 0,
	extra: Partial<Call> = {},
): Call {
	return { session: "/s", ms: at(day), provider, model, input, output, cacheRead: 0, cacheWrite: 0, cost: 0, ...extra };
}

interface Assistant {
	ms: number;
	provider: string;
	model: string;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
}

export function assistantLine({
	ms,
	provider,
	model,
	input = 0,
	output = 0,
	cacheRead = 0,
	cacheWrite = 0,
	cost = 0,
}: Assistant): string {
	return JSON.stringify({
		type: "message",
		id: Math.random().toString(16).slice(2, 10),
		timestamp: new Date(ms).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "x",
			provider,
			model,
			usage: {
				input,
				output,
				cacheRead,
				cacheWrite,
				totalTokens: input + output + cacheRead + cacheWrite,
				cost: { total: cost },
			},
			stopReason: "stop",
			timestamp: ms,
		},
	});
}

export function sessionFile(
	path: string,
	opts: { startMs: number; parentSession?: string; name?: string; lines: string[] },
): void {
	mkdirSync(dirname(path), { recursive: true });
	const header = JSON.stringify({
		type: "session",
		version: 3,
		id: path,
		timestamp: new Date(opts.startMs).toISOString(),
		cwd: "/x",
		...(opts.parentSession ? { parentSession: opts.parentSession } : {}),
	});
	const info = opts.name
		? [
				JSON.stringify({
					type: "session_info",
					id: "i",
					timestamp: new Date(opts.startMs).toISOString(),
					name: opts.name,
				}),
			]
		: [];
	writeFileSync(path, `${[header, ...info, ...opts.lines].join("\n")}\n`);
}
