/**
 * Opt-in, content-free Anthropic classification trace. Load with `pi -e <this file>`
 * and PI_TRANSCRIPT_TYPES_DIR=<private directory>. Never installed automatically.
 * Observes parsed provider types, normalized updates, message-end handlers, and
 * the session-manager view at settle. That last view is not a disk readback.
 */
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_BLOCKS = 128;
const MAX_BYTES = 2 * 1024 * 1024;
const BLOCK_TYPES = new Set([
	"text",
	"thinking",
	"redacted_thinking",
	"tool_use",
	"toolCall",
]);
const DELTA_TYPES = new Set([
	"text_delta",
	"thinking_delta",
	"signature_delta",
	"input_json_delta",
]);

type SafeRecord = {
	stage:
		| "start"
		| "raw_start"
		| "raw_block"
		| "raw_delta"
		| "raw_stop"
		| "normalized"
		| "message_end"
		| "session"
		| "capture_limit";
	request?: number;
	index?: number;
	block?: string;
	blocks?: string[];
	truncated?: boolean;
};

/** Project only allowlisted labels. Never stringify an input event or message. */
export function blockTypes(
	content: unknown,
): Pick<SafeRecord, "blocks" | "truncated"> {
	if (!Array.isArray(content)) return { blocks: [], truncated: false };
	return {
		blocks: content.slice(0, MAX_BLOCKS).map((block: unknown) => {
			if (!block || typeof block !== "object" || !("type" in block))
				return "unknown";
			return typeof block.type === "string" && BLOCK_TYPES.has(block.type)
				? block.type
				: "unknown";
		}),
		truncated: content.length > MAX_BLOCKS,
	};
}

/** Bounded projection of provider events; one delta label per block/type per request. */
export class TypeTrace {
	private request = 0;
	private deltas = new Set<string>();
	private overflow = false;

	constructor(privateEmit: (record: SafeRecord) => void) {
		this.emit = privateEmit;
	}
	private readonly emit: (record: SafeRecord) => void;

	raw(data: unknown): void {
		if (!data || typeof data !== "object" || !("type" in data)) return;
		if (data.type === "message_start") {
			this.request++;
			this.deltas.clear();
			this.overflow = false;
			this.emit({ stage: "raw_start", request: this.request });
			return;
		}
		if (data.type === "message_stop") {
			this.emit({ stage: "raw_stop", request: this.request });
			return;
		}
		if (
			!("index" in data) ||
			typeof data.index !== "number" ||
			!Number.isInteger(data.index) ||
			data.index < 0
		)
			return;
		if (data.index >= MAX_BLOCKS) {
			if (!this.overflow) {
				this.overflow = true;
				this.emit({
					stage: "raw_block",
					request: this.request,
					truncated: true,
				});
			}
			return;
		}
		if (data.type === "content_block_start" && "content_block" in data) {
			const block = blockTypes([data.content_block]).blocks?.[0] ?? "unknown";
			this.emit({
				stage: "raw_block",
				request: this.request,
				index: data.index,
				block,
			});
		} else if (data.type === "content_block_delta" && "delta" in data) {
			const delta = data.delta;
			const type =
				delta && typeof delta === "object" && "type" in delta
					? delta.type
					: undefined;
			const block =
				typeof type === "string" && DELTA_TYPES.has(type) ? type : "unknown";
			const key = `${data.index}:${block}`;
			if (this.deltas.has(key)) return;
			this.deltas.add(key);
			this.emit({
				stage: "raw_delta",
				request: this.request,
				index: data.index,
				block,
			});
		}
	}

	message(
		stage: "normalized" | "message_end" | "session",
		content: unknown,
	): void {
		this.emit({ stage, request: this.request, ...blockTypes(content) });
	}
}

export default function transcriptTypes(pi: ExtensionAPI): void {
	const directory = process.env.PI_TRANSCRIPT_TYPES_DIR;
	if (!directory) return;
	let fd: number | undefined;
	let bytes = 0;
	let lastNormalized = "";
	let pendingSession = false;
	let trace: TypeTrace | undefined;

	const close = (): boolean => {
		const current = fd;
		fd = undefined;
		trace = undefined;
		try {
			if (current !== undefined) closeSync(current);
			return true;
		} catch {
			return false;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		try {
			if (!close()) {
				ctx.ui.notify(
					"Transcript type capture stopped after a close failure",
					"warning",
				);
				return;
			}
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			fd = openSync(
				join(directory, `transcript-types-${randomUUID()}.jsonl`),
				"wx",
				0o600,
			);
			bytes = 0;
			lastNormalized = "";
			pendingSession = false;
			const emit = (record: SafeRecord): void => {
				if (fd === undefined) return;
				try {
					const line = `${JSON.stringify({ pid: process.pid, time: Date.now(), ...record })}\n`;
					if (bytes + Buffer.byteLength(line) > MAX_BYTES) {
						writeSync(fd, '{"stage":"capture_limit"}\n');
						const closed = close();
						ctx.ui.notify(
							closed
								? "Transcript type capture reached its 2 MiB limit; capture stopped"
								: "Transcript type capture stopped after a close failure",
							"warning",
						);
						return;
					}
					writeSync(fd, line);
					bytes += Buffer.byteLength(line);
				} catch {
					close();
					ctx.ui.notify(
						"Transcript type capture stopped after an I/O failure",
						"warning",
					);
				}
			};
			trace = new TypeTrace(emit);
			emit({ stage: "start" });
		} catch {
			close();
			ctx.ui.notify("Transcript type capture could not start", "warning");
		}
	});
	pi.on("provider_stream_event", (event) => {
		if (event.api === "anthropic-messages") trace?.raw(event.data);
	});
	pi.on("message_update", (event) => {
		if (!trace) return;
		if (
			event.message.role !== "assistant" ||
			event.message.api !== "anthropic-messages"
		)
			return;
		const shape = JSON.stringify(blockTypes(event.message.content));
		if (shape === lastNormalized) return;
		lastNormalized = shape;
		trace?.message("normalized", event.message.content);
	});
	pi.on("message_end", (event) => {
		if (
			event.message.role === "assistant" &&
			event.message.api === "anthropic-messages"
		) {
			trace?.message("message_end", event.message.content);
			pendingSession = trace !== undefined;
			lastNormalized = "";
		}
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (!trace || !pendingSession) return;
		pendingSession = false;
		// Snapshot only after a newly observed assistant message, never on capture startup.
		const latest = ctx.sessionManager
			.getBranch()
			.findLast(
				(entry) =>
					entry.type === "message" && entry.message.role === "assistant",
			);
		if (!latest || latest.type !== "message") return;
		if (
			latest.message.role === "assistant" &&
			latest.message.api === "anthropic-messages"
		) {
			trace.message("session", latest.message.content);
		}
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (!close())
			ctx.ui.notify(
				"Transcript type capture stopped after a close failure",
				"warning",
			);
	});
}
