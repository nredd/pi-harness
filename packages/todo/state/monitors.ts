/**
 * Which `session-kit` monitors are running per session, fed by `session-kit:monitor:started` and
 * `:stopped` on `pi.events` (`{ sessionId, id, name }`). A running monitor wakes the parent on its
 * match or exit, so at a settle it counts as an armed wake. Either package works without the
 * other: no session-kit means no events, so nothing is ever reported as armed by a monitor.
 */

import { MONITOR_STARTED_EVENT } from "../tool/types.ts";

const sessions = new Map<string, Set<string>>();

/** Record one monitor lifecycle event, `started` or `stopped`; malformed payloads are ignored. */
export function applyMonitorEvent(channel: string, payload: unknown): void {
	if (!payload || typeof payload !== "object") return;
	const { sessionId, id } = payload as Record<string, unknown>;
	if (typeof sessionId !== "string" || typeof id !== "string" || !id) return;
	if (channel === MONITOR_STARTED_EVENT) {
		const ids = sessions.get(sessionId) ?? new Set<string>();
		ids.add(id);
		sessions.set(sessionId, ids);
		return;
	}
	const ids = sessions.get(sessionId);
	ids?.delete(id);
	if (ids?.size === 0) sessions.delete(sessionId);
}

/** Whether any monitor of `sessionId` is running. */
export function hasRunningMonitor(sessionId: string): boolean {
	return sessions.has(sessionId);
}

/** Drop everything `sessionId` tracked; called when that session shuts down. */
export function forgetMonitors(sessionId: string): void {
	sessions.delete(sessionId);
}

/** Test-only: forget every tracked monitor. */
export function __resetMonitors(): void {
	sessions.clear();
}
