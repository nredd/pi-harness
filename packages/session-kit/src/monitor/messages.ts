/** Formats coalesced monitor output and lifecycle events as one custom-message body. */

import type { CoalescedBatch } from "./coalescer.ts";
import type { NumberedLine } from "./ring.ts";
import type { MonitorInfo, MonitorMessage } from "./types.ts";

export const MAX_MESSAGE_LINES = 40;
export const MAX_MESSAGE_BYTES = 8 * 1024;

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
			return `timed out after ${took} and was killed; ${info.lines} lines total`;
		case "stopped":
			return `stopped after ${took}; ${info.lines} lines total`;
		default:
			return info.signal
				? `died from ${info.signal} after ${took}; ${info.lines} lines total`
				: `exited with code ${info.exitCode ?? "?"} after ${took}; ${info.lines} lines total`;
	}
}

/** Keep the newest lines that fit both caps; returns them and how many older ones were dropped. */
function bound(lines: TaggedLine[]): { kept: TaggedLine[]; omitted: number } {
	let kept = lines.slice(-MAX_MESSAGE_LINES);
	let bytes = 0;
	let from = kept.length;
	while (from > 0) {
		const next = bytes + Buffer.byteLength(kept[from - 1]?.text ?? "") + 8;
		if (next > MAX_MESSAGE_BYTES && from < kept.length) break;
		bytes = next;
		from--;
	}
	kept = kept.slice(from);
	return { kept, omitted: lines.length - kept.length };
}

export function formatMessage(
	info: MonitorInfo,
	input: CoalescedBatch<TaggedLine> | TaggedLine[],
	opts: { final: boolean; wake: boolean },
): MonitorMessage {
	const batch = Array.isArray(input) ? { items: input, dropped: 0, droppedMatched: false } : input;
	const head = `[monitor ${info.id} "${info.name}"]`;
	const parts: string[] = [];
	const matched = batch.items.filter((l) => l.matched).map((l) => l.n);
	if (batch.items.length > 0 || batch.dropped > 0) {
		const { kept, omitted } = bound(batch.items);
		const first = (batch.items[0]?.n ?? info.lines + 1) - batch.dropped;
		const last = batch.items.at(-1)?.n ?? info.lines;
		const total = batch.items.length + batch.dropped;
		const tag =
			matched.length > 0
				? `; match on ${matched.slice(0, 5).join(", ")}${matched.length > 5 ? ", ..." : ""}`
				: batch.droppedMatched
					? "; match"
					: "";
		parts.push(`${head} lines ${first}-${last} (${total} new${tag})`);
		if (batch.dropped > 0)
			parts.push(
				`... ${batch.dropped} lines dropped from the pending 2s batch; monitor_read {"id":"${info.id}","since":${first - 1}} has them`,
			);
		if (omitted > 0)
			parts.push(
				`... ${omitted} earlier lines omitted; monitor_read {"id":"${info.id}","since":${first - 1}} has them`,
			);
		for (const l of kept) parts.push(`${l.n}: ${l.text}`);
	}
	if (opts.final) parts.push(`${head} ${exitNote(info)}`);
	return {
		text: parts.join("\n"),
		wake: opts.wake,
		details: {
			id: info.id,
			name: info.name,
			firstLine: (batch.items[0]?.n ?? info.lines + 1) - batch.dropped,
			lastLine: batch.items.at(-1)?.n ?? info.lines,
			matched,
			status: info.status,
		},
	};
}
