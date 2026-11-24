import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import type { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Call } from "../../../src/stats/load.ts";
import type { Manifest } from "../../../src/stats/snapshot.ts";

/** Where an export records one outbox's bookkeeping: keyed by the resolved snapshot directory. */
export function outboxStatePath(agent: string, snapshotDir: string): string {
	const key = createHash("sha256").update(realpathSync(snapshotDir)).digest("hex");
	return join(agent, "pi-session-kit", "outboxes", `${key}.json`);
}

/** UTC instant for `YYYY-MM-DD` at `hour`: snapshot shards, seals and quota windows key on UTC months. */
export function utcAt(day: string, hour = 12): number {
	return Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
}

/** Where an export records one outbox's publication watermark, beside its bookkeeping. */
export function outboxWatermarkPath(agent: string, snapshotDir: string): string {
	return outboxStatePath(agent, snapshotDir).replace(/\.json$/, ".published.json");
}

/** Parse `manifest.json` from `snapshotDir`. */
export function manifestOf(snapshotDir: string): Manifest {
	return JSON.parse(readFileSync(join(snapshotDir, "manifest.json"), "utf8")) as Manifest;
}

/** Build a `readFile` implementation that fails with `code` on `deniedPath` and delegates everything else. */
export function denyPathOnRead(actualReadFile: typeof readFile, deniedPath: string, code = "EACCES"): typeof readFile {
	return (async (...[file, options]: Parameters<typeof readFile>) => {
		if (file === deniedPath)
			throw Object.assign(new Error(`${code}: denied, open '${deniedPath}'`), {
				code,
				syscall: "open",
				path: deniedPath,
			});
		return actualReadFile(file, options);
	}) as typeof readFile;
}

/** Local-time instant for `YYYY-MM-DD` at `hour`: day and hour views bucket in local time. */
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
	return {
		harness: "pi",
		session: "/s",
		ms: at(day),
		provider,
		model,
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		...extra,
	};
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
