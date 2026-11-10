/**
 * Which `session-kit` monitors are running per session, fed by `session-kit:monitor:started` and
 * `:stopped` on `pi.events` (`{ sessionId, id, name, todo? }`). A running monitor wakes the parent
 * on its match or exit, so at a settle it counts as an armed wake. One started for a todo (`todo`)
 * arms only that todo; one without a link arms the whole session. Either package works without the
 * other: no session-kit means no events, so nothing is ever reported as armed by a monitor.
 */

import { MONITOR_STARTED_EVENT } from "../tool/types.ts";

interface Running {
	name: string;
	/** The todo id the monitor was started for; absent for a session-wide wake. */
	todo?: number;
}

const sessions = new Map<string, Map<string, Running>>();

/** Record one monitor lifecycle event, `started` or `stopped`; malformed payloads are ignored. */
export function applyMonitorEvent(channel: string, payload: unknown): void {
	if (!payload || typeof payload !== "object") return;
	const { sessionId, id, name, todo } = payload as Record<string, unknown>;
	if (typeof sessionId !== "string" || typeof id !== "string" || !id) return;
	if (channel === MONITOR_STARTED_EVENT) {
		const running = sessions.get(sessionId) ?? new Map<string, Running>();
		const link = Number.isSafeInteger(todo) && (todo as number) >= 1 ? { todo: todo as number } : {};
		running.set(id, { name: typeof name === "string" && name ? name : id, ...link });
		sessions.set(sessionId, running);
		return;
	}
	const running = sessions.get(sessionId);
	running?.delete(id);
	if (running?.size === 0) sessions.delete(sessionId);
}

/** Whether any monitor of `sessionId` not linked to a todo is running: a session-wide armed wake. */
export function hasRunningMonitor(sessionId: string): boolean {
	return [...(sessions.get(sessionId)?.values() ?? [])].some((m) => m.todo === undefined);
}

/** Running monitors of `sessionId` by the todo id they were started for; the first named wins. */
export function monitorsByTodo(sessionId: string): Map<number, string> {
	const byTodo = new Map<number, string>();
	for (const { name, todo } of sessions.get(sessionId)?.values() ?? [])
		if (todo !== undefined && !byTodo.has(todo)) byTodo.set(todo, name);
	return byTodo;
}

/** Drop everything `sessionId` tracked; called when that session shuts down. */
export function forgetMonitors(sessionId: string): void {
	sessions.delete(sessionId);
}

/** Test-only: forget every tracked monitor. */
export function __resetMonitors(): void {
	sessions.clear();
}
