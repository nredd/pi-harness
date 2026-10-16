/**
 * Pure `/loop` logic: interval and command parsing, the tick decision and list formatting.
 * No pi imports.
 */

export const MIN_INTERVAL_MS = 30_000;
/** Longer than this and every tick finds a cold prompt cache (5 minute TTL). */
export const CACHE_WARM_MS = 5 * 60_000;
export const MAX_INTERVAL_MS = 24 * 60 * 60_000;
/** Hard ceiling on `--max`: larger requests are clamped, never honoured. */
export const MAX_RUNS_CEILING = 50;
export const DEFAULT_MAX_RUNS = MAX_RUNS_CEILING;

export type LoopCommand =
	| { kind: "start"; intervalMs: number; prompt: string; maxRuns: number }
	| { kind: "list" }
	| { kind: "stop" | "resume"; target: string }
	| { kind: "error"; message: string };

const UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };

/** `30s`, `5m`, `1h` -> milliseconds, or an error string. */
export function parseInterval(raw: string): { ok: true; ms: number } | { ok: false; error: string } {
	const match = /^(\d+)([smh])$/i.exec(raw.trim());
	if (!match) return { ok: false, error: `bad interval "${raw}" (use 30s, 5m or 1h)` };
	const ms = Number(match[1]) * (UNITS[(match[2] as string).toLowerCase()] as number);
	if (ms < MIN_INTERVAL_MS) return { ok: false, error: `interval ${raw} is below the 30s minimum` };
	if (ms > MAX_INTERVAL_MS) return { ok: false, error: `interval ${raw} is above the 24h maximum` };
	return { ok: true, ms };
}

export function formatInterval(ms: number): string {
	if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
	if (ms % 60_000 === 0) return `${ms / 60_000}m`;
	return `${ms / 1_000}s`;
}

const USAGE = "usage: /loop <30s|5m|1h> <prompt> [--max N] | list | stop [id|all] | resume [id|all]";

/** Parse `/loop` arguments. A bare `/loop` lists. */
export function parseLoopArgs(raw: string): LoopCommand {
	const text = raw.trim();
	if (text === "" || text === "list") return { kind: "list" };
	const [head = "", ...rest] = text.split(/\s+/);
	if (head === "stop" || head === "resume") {
		if (rest.length > 1) return { kind: "error", message: USAGE };
		return { kind: head, target: rest[0] ?? "all" };
	}
	const interval = parseInterval(head);
	if (!interval.ok) return { kind: "error", message: `${interval.error}. ${USAGE}` };
	const words: string[] = [];
	let maxRuns = DEFAULT_MAX_RUNS;
	for (let i = 0; i < rest.length; i++) {
		const token = rest[i] as string;
		const flag = /^--max(?:=(.*))?$/.exec(token);
		if (!flag) {
			words.push(token);
			continue;
		}
		const value = flag[1] ?? rest[++i] ?? "";
		const count = /^\d+$/.test(value) ? Number(value) : Number.NaN;
		if (!Number.isSafeInteger(count) || count < 1)
			return { kind: "error", message: `--max needs a positive integer (got "${value}")` };
		maxRuns = Math.min(count, MAX_RUNS_CEILING);
	}
	const prompt = words.join(" ");
	if (prompt === "") return { kind: "error", message: USAGE };
	return { kind: "start", intervalMs: interval.ms, prompt, maxRuns };
}

export interface LoopEntry {
	id: string;
	intervalMs: number;
	prompt: string;
	maxRuns: number;
	runs: number;
	skipped: number;
	/** Why ticks are suspended (provider error); cleared by `/loop resume`. */
	paused?: string;
}

export interface TickInput {
	isChild: boolean;
	busy: boolean;
	goalActive: boolean;
	planMode: boolean;
	loop: LoopEntry;
}

export type TickDecision = { fire: true } | { fire: false; reason: string };

/** Whether a timer tick may send the prompt. A skip never counts as a run and never queues. */
export function decideTick(input: TickInput): TickDecision {
	if (input.isChild) return { fire: false, reason: "child session" };
	if (input.loop.paused) return { fire: false, reason: "paused" };
	if (input.loop.runs >= input.loop.maxRuns) return { fire: false, reason: "run cap reached" };
	if (input.goalActive) return { fire: false, reason: "goal active" };
	if (input.planMode) return { fire: false, reason: "plan mode" };
	if (input.busy) return { fire: false, reason: "agent busy" };
	return { fire: true };
}

export function describeLoop(loop: LoopEntry): string {
	const prompt = loop.prompt.length > 60 ? `${loop.prompt.slice(0, 57)}...` : loop.prompt;
	const pause = loop.paused ? ` [paused: ${loop.paused}]` : "";
	return `${loop.id}: every ${formatInterval(loop.intervalMs)}, ${loop.runs}/${loop.maxRuns} runs, ${loop.skipped} skipped: ${prompt}${pause}`;
}
