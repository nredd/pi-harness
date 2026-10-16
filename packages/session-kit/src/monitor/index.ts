/**
 * `/monitor`: background process watchers the model can start, read and stop.
 *
 * - `monitor_start` / `monitor_read` / `monitor_stop` tools and a `/monitor` command (list, stop)
 * - output is coalesced for 2s into ONE custom message per monitor; the agent is only woken on a
 *   `match` hit, on exit/timeout, or when `wake: true`, otherwise the message is passive context
 * - every child dies on `session_shutdown`, which pi fires for quit AND for /new, /resume, /fork
 *   and /reload (a reload replaces the extension runtime, so a monitor could not be reattached
 *   anyway). A SIGKILLed pi leaves pidfiles; the next session sweeps only dead owners' files
 * - plan mode: only `monitor_read` carries `readOnlyHint`, so the `pi-plan-mode` fork admits just
 *   that. `monitor_start` runs arbitrary argv and goes through the normal `tool_call` guards
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isChildSession, registerChildIdentity, registerParentTool } from "../child.ts";
import type { KitConfig } from "../config.ts";
import { MonitorError, MonitorManager } from "./manager.ts";
import { formatDuration } from "./messages.ts";
import { boundTail } from "./output.ts";
import { ensureRoot, rootDir, sessionDirName, sweepOrphans } from "./pidfiles.ts";
import type { MonitorInfo } from "./types.ts";
import { MAX_MONITORS, MAX_TIMEOUT_S } from "./validate.ts";
import { MonitorWidget } from "./widget.ts";

export const MESSAGE_TYPE = "session-kit:monitor";
export const TOOL_NAMES = ["monitor_start", "monitor_read", "monitor_stop"] as const;

const NOT_AVAILABLE = "monitors are not available in this session";

function describe(info: MonitorInfo): string {
	const age = formatDuration((info.endedAt ?? Date.now()) - info.startedAt);
	const state =
		info.status === "running"
			? `running ${age}`
			: info.signal
				? `${info.status} (${info.signal}) after ${age}`
				: `${info.status} (code ${info.exitCode ?? "?"}) after ${age}`;
	const extra = [info.match ? `match /${info.match}/` : "", info.wake ? "wake" : ""].filter(Boolean).join(" ");
	return `${info.id} "${info.name}" ${state}, ${info.lines} lines, pid ${info.pid}${extra ? `, ${extra}` : ""}: ${info.argv.join(" ")}`;
}

function text(out: string, details?: unknown, isError = false) {
	return { content: [{ type: "text" as const, text: out }], details, isError };
}

export function register(pi: ExtensionAPI, _config: KitConfig): void {
	registerChildIdentity(pi);
	let manager: MonitorManager | undefined;
	let widget: MonitorWidget | undefined;

	const teardown = async (): Promise<void> => {
		const old = manager;
		const oldWidget = widget;
		manager = undefined;
		widget = undefined;
		oldWidget?.dispose();
		await old?.dispose();
	};

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		await teardown();
		if (isChildSession(pi)) return;
		const sessionId = ctx.sessionManager.getSessionId();
		const root = rootDir();
		try {
			ensureRoot(root);
		} catch (error) {
			ctx.ui.notify(`/monitor: cannot create ${root}: ${(error as Error).message}`, "warning");
			return;
		}
		const w = new MonitorWidget(() => manager?.running() ?? []);
		w.attach(ctx);
		widget = w;
		manager = new MonitorManager({
			sessionId,
			root,
			send: (message) => {
				pi.sendMessage(
					{ customType: MESSAGE_TYPE, content: message.text, display: true, details: message.details },
					message.wake ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: false },
				);
			},
			onChange: () => w.refresh(),
		});
		// Fire and forget: never delay startup on the sweep, and never let it throw into pi.
		sweepOrphans(root, sessionDirName(sessionId, process.pid))
			.then((result) => {
				if (result.failed.length)
					ctx.ui.notify(`/monitor: retained uncertain or busy orphan records: ${result.failed.join(", ")}`, "warning");
			})
			.catch((error: unknown) => ctx.ui.notify(`/monitor: orphan cleanup failed: ${String(error)}`, "warning"));
	});

	pi.on("session_shutdown", teardown);

	registerParentTool(pi, {
		name: "monitor_start",
		label: "Monitor start",
		description:
			"Start a long-running background process (log tail, watcher, poller) and get its output as it appears. " +
			'argv is spawned directly with no shell; use ["sh","-c","..."] explicitly for pipes. ' +
			"Output lines are coalesced for 2s into one message. You are woken only when a line matches `match` " +
			"(JS regex), when the process exits or times out, or on every batch when `wake` is true; otherwise output " +
			"is passive context and monitor_read fetches it. Do not use this for commands that finish quickly.",
		promptSnippet: "Start a background process and be woken on matching output or exit",
		parameters: Type.Object({
			argv: Type.Array(Type.String(), { minItems: 1, description: "Command and arguments, no shell" }),
			name: Type.String({ description: "Unique short name, [A-Za-z0-9._-]" }),
			match: Type.Optional(Type.String({ description: "JS regex; a matching line wakes you" })),
			wake: Type.Optional(Type.Boolean({ description: "Wake on every output batch" })),
			timeout_s: Type.Optional(
				Type.Number({ minimum: 1, maximum: MAX_TIMEOUT_S, description: "Kill after this many seconds (default 3600)" }),
			),
		}),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		async execute(_id, params, _signal, _update, ctx) {
			if (!manager) return text(NOT_AVAILABLE, undefined, true);
			try {
				const info = await manager.start(params, ctx.cwd);
				const how = info.match
					? `wakes on /${info.match}/`
					: info.wake
						? "wakes on every batch"
						: "passive (wakes on exit)";
				return text(
					`started ${info.id} "${info.name}" (pid ${info.pid}); ${how}; killed after ${formatDuration(info.timeoutMs)}. ` +
						`${MAX_MONITORS} monitors max per session.`,
					info,
				);
			} catch (error) {
				if (error instanceof MonitorError) return text(error.message, undefined, true);
				throw error;
			}
		},
	});

	registerParentTool(pi, {
		name: "monitor_read",
		label: "Monitor read",
		description:
			"Read buffered output (last 2000 lines kept) of a monitor by id or name. `since` is a line number: only " +
			"later lines are returned. The result ends with `next since` to pass on the following call.",
		promptSnippet: "Read output of a running or finished background monitor",
		parameters: Type.Object({
			id: Type.String({ description: "Monitor id (m1) or name" }),
			since: Type.Optional(Type.Number({ minimum: 0, description: "Only lines numbered after this" })),
		}),
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute(_id, params) {
			if (!manager) return text(NOT_AVAILABLE, undefined, true);
			const read = manager.read(params.id, params.since);
			if (!read) return text(`no monitor "${params.id}"; /monitor lists them`, undefined, true);
			const { info } = read;
			const head = [describe(info)];
			if (read.missed > 0) head.push(`${read.missed} older lines were evicted from the 2000-line buffer`);
			const body = read.lines.map((l) => `${l.n}: ${l.text}`).join("\n");
			const bounded = await boundTail(body, `${info.id}-read`);
			const tail = `next since: ${read.lastLine}`;
			return text([...head, bounded.text || "(no new output)", tail].join("\n"), {
				...info,
				lastLine: read.lastLine,
				fullOutputPath: bounded.fullOutputPath,
			});
		},
	});

	registerParentTool(pi, {
		name: "monitor_stop",
		label: "Monitor stop",
		description: "Stop a monitor by id or name: SIGTERM to its process group, SIGKILL after 2s.",
		promptSnippet: "Stop a background monitor",
		parameters: Type.Object({ id: Type.String({ description: "Monitor id (m1) or name" }) }),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		async execute(_id, params) {
			if (!manager) return text(NOT_AVAILABLE, undefined, true);
			const info = await manager.stop(params.id);
			if (!info) return text(`no monitor "${params.id}"; /monitor lists them`, undefined, true);
			return text(describe(info), info);
		},
	});

	pi.registerCommand("monitor", {
		description: "List background monitors, or `stop <id|name|all>`",
		getArgumentCompletions: (prefix) =>
			["list", "stop all", ...(manager?.running().map((m) => `stop ${m.id}`) ?? [])]
				.filter((c) => c.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		async handler(args, ctx) {
			if (!manager) {
				ctx.ui.notify(`/monitor: ${NOT_AVAILABLE}`, "warning");
				return;
			}
			const [sub = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const target = rest.join(" ");
			if (sub === "list" && rest.length === 0) {
				const all = manager.list();
				ctx.ui.notify(all.length === 0 ? "no monitors" : all.map(describe).join("\n"), "info");
			} else if (sub === "stop" && target === "all") {
				const stopped = await manager.stopAll();
				ctx.ui.notify(
					stopped.length === 0 ? "no running monitors" : `stopped ${stopped.map((m) => m.id).join(", ")}`,
					"info",
				);
			} else if (sub === "stop" && target) {
				const info = await manager.stop(target);
				ctx.ui.notify(info ? `stopped ${describe(info)}` : `no monitor "${target}"`, info ? "info" : "error");
			} else {
				ctx.ui.notify("usage: /monitor [list] | /monitor stop <id|name|all>", "warning");
			}
		},
	});
}
