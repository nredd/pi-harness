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
