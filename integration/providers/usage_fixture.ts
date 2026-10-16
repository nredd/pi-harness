/**
 * Router usage stand-in for the quota-footer scenarios; loaded with `-e`, never installed.
 *
 * Answers `router:rpc:usage` on the event bus with the pi-subagents RPC envelope
 * (`{ success: true, data: { snapshots, blocks } }` on `router:rpc:usage:reply:<requestId>`), so the
 * footer sees what the real `pi-subscription-router` would send, with no credentials or network.
 *
 * `HARNESS_USAGE_STATE` points at a JSON file re-read on EVERY request, so a scenario changes what
 * the next poll sees by rewriting it:
 *   { "mode": "ok" | "hang" | "error", "snapshots": [UsageSnapshot, ...], "blocks": [...] }
 * `hang` never replies (the footer's request timeout), `error` replies `{ success: false }`.
 * `HARNESS_USAGE_LOG` receives one JSON line per request: `{ "t": <epoch ms>, "refresh": <param>, "ready": <startup finished> }`.
 * It also sets one extension status, so a scenario can prove the status line is left intact.
 */

import { appendFileSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CHANNEL = "router:rpc:usage";
const STATUS_KEY = "harness-usage";
const STATUS_TEXT = "STATUS-LINE-OK";

interface State {
	mode?: "ok" | "hang" | "error";
	snapshots?: unknown[];
	blocks?: unknown[];
}

function readState(): State {
	const path = process.env.HARNESS_USAGE_STATE;
	if (!path) throw new Error("usage_fixture.ts needs HARNESS_USAGE_STATE");
	return JSON.parse(readFileSync(path, "utf8")) as State;
}

export default function (pi: ExtensionAPI) {
	let ready = false;
	let startupTimer: ReturnType<typeof setTimeout> | undefined;
	pi.on("session_shutdown", () => clearTimeout(startupTimer));
	pi.on("session_start", (_event, ctx) => {
		clearTimeout(startupTimer);
		ready = false;
		// Represent a provider becoming ready after the startup dispatch finishes.
		// An inline request from another session_start handler is too early.
		startupTimer = setTimeout(() => {
			startupTimer = undefined;
			ready = true;
		}, 0);
		if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, STATUS_TEXT);
	});

	pi.events.on(CHANNEL, (raw) => {
		const params = (raw && typeof raw === "object" ? raw : {}) as Record<
			string,
			unknown
		>;
		const requestId =
			typeof params.requestId === "string" ? params.requestId : undefined;
		const log = process.env.HARNESS_USAGE_LOG;
		if (log)
			appendFileSync(
				log,
				`${JSON.stringify({ t: Date.now(), refresh: params.refresh, ready })}\n`,
			);
		if (!requestId) return;
		const state = readState();
		if (state.mode === "hang") return;
		const reply = `${CHANNEL}:reply:${requestId}`;
		if (state.mode === "error") {
			pi.events.emit(reply, { success: false, error: "harness usage error" });
			return;
		}
		pi.events.emit(reply, {
			success: true,
			data: { snapshots: state.snapshots ?? [], blocks: state.blocks ?? [] },
		});
	});
}
