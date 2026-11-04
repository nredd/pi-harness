/** Formats compact monitor wake and lifecycle custom messages. */

import type { CoalescedBatch } from "./coalescer.ts";
import type { NumberedLine } from "./ring.ts";
import type { MonitorInfo, MonitorMessage } from "./types.ts";

export type TaggedLine = NumberedLine & { matched: boolean };

export function formatDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function exitNote(info: MonitorInfo): string {
	const took = formatDuration((info.endedAt ?? Date.now()) - info.startedAt);
	switch (info.status) {
		case "timeout":
			return `timed out after ${took} and was killed`;
		case "stopped":
			return `stopped after ${took}`;
		default:
			return info.signal
				? `died from ${info.signal} after ${took}`
				: `exited with code ${info.exitCode ?? "?"} after ${took}`;
	}
}

// Terminal control characters, written as regex escape text (`\\u001b`, not the character itself),
// so no pattern below holds a raw control character for `noControlCharactersInRegex` to flag.
const ESC = "\\u001b";
const BEL = "\\u0007";
const CSI_C1 = "\\u009b";
const OSC_C1 = "\\u009d";
const ST_C1 = "\\u009c";
const C0 = "\\u0000-\\u001f";
const C1 = "\\u007f-\\u009f";
/** CSI sequences, via both ESC-[ and the C1 single-byte introducer. */
const CSI_SEQUENCE = new RegExp(`(?:${ESC}\\[|${CSI_C1})[0-?]*[ -/]*[@-~]`, "g");
/** OSC sequences with their payload; an unterminated OSC swallows the rest, as a terminal would. */
const OSC_SEQUENCE = new RegExp(`(?:${ESC}\\]|${OSC_C1})[^${BEL}${ST_C1}${ESC}]*(?:${BEL}|${ST_C1}|${ESC}\\\\)?`, "g");
/** Any remaining two-character ESC sequence. */
const ESC_PAIR = new RegExp(`${ESC}.`, "g");
const CONTROL_CHARACTER = new RegExp(`[${C0}${C1}]`, "g");

/**
 * Remove terminal control characters from model-controlled text (a monitor's `match`) before it
 * reaches `ctx.ui.notify`: whole CSI/OSC sequences, other ESC pairs, C0/C1 controls (newlines and
 * tabs become spaces) and bidi controls. The same rules as `packages/todo/tool/sanitize.ts`; the
 * packages publish independently and share no runtime dependency, so it is mirrored, not imported.
 */
function sanitizeTerminalText(value: string): string {
	return (
		value
			.replace(CSI_SEQUENCE, "")
			.replace(OSC_SEQUENCE, "")
			.replace(ESC_PAIR, "")
			// Unicode line/paragraph separators join lines like \n does below.
			.replace(/[\u2028\u2029]/g, " ")
			.replace(CONTROL_CHARACTER, (character) =>
				character === "\n" || character === "\r" || character === "\t" ? " " : "",
			)
			// Bidi embedding/override/isolate controls and LRM/RLM marks.
			.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
	);
}

/**
 * What wakes the parent from a running monitor: every batch with `wake`, else a `match` line, and
 * always a natural exit or timeout. Only `monitor_stop` ends one without a wake.
 */
function armedOn(info: MonitorInfo): string {
	const on = info.wake ? "every batch or " : info.match ? `/${sanitizeTerminalText(info.match)}/ or ` : "";
	return `${info.id} "${info.name}" on ${on}exit`;
}

/**
 * The settle report for running monitors, or `undefined` when none are running. Same shape as the
 * `subagents` and `todo` settle notices, `Run ended with N <work>, armed: <what wakes the parent>`,
 * naming only monitors. Every running monitor is armed: natural exit and timeout always wake.
 */
export function formatPendingMonitors(running: MonitorInfo[]): string | undefined {
	if (running.length === 0) return undefined;
	const plural = running.length === 1 ? "" : "s";
	return `Run ended with ${running.length} monitor${plural} running, armed: ${running.map(armedOn).join(", ")}`;
}

/** A wake names its event and cursor without replaying passive buffered output. */
export function formatMessage(
	info: MonitorInfo,
	input: CoalescedBatch<TaggedLine> | TaggedLine[],
	opts: { final: boolean; wake: boolean; since?: number },
): MonitorMessage {
	const batch = Array.isArray(input) ? { items: input, dropped: 0, droppedMatched: false, droppedMatches: [] } : input;
	const matched = [...batch.items.filter((line) => line.matched), ...batch.droppedMatches].sort((a, b) => a.n - b.n);
	const firstLine = (batch.items[0]?.n ?? info.lines + 1) - batch.dropped;
	const lastLine = batch.items.at(-1)?.n ?? info.lines;
	const readSince = Math.max(0, opts.since ?? 0);
	const head = `[monitor ${info.id} "${info.name}"]`;
	const parts = [head];
	if (matched.length > 0) {
		const first = matched[0];
		const last = matched.at(-1);
		parts.push(
			first === last
				? `matched line ${first?.n}: ${first?.text}`
				: `matched lines ${first?.n}: ${first?.text}; ${last?.n}: ${last?.text}`,
		);
	} else if (!opts.final && batch.items.length > 0) {
		const line = batch.items.at(-1);
		parts.push(`output line ${line?.n}: ${line?.text}`);
	}
	if (opts.final) parts.push(exitNote(info));
	parts.push(`monitor_read {"id":"${info.id}","since":${readSince}}`);
	return {
		text: parts.join("\n"),
		wake: opts.wake,
		details: {
			id: info.id,
			name: info.name,
			firstLine,
			lastLine,
			matched: matched.map((line) => line.n),
			status: info.status,
		},
	};
}
