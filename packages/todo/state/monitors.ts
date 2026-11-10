/**
 * Which `session-kit` monitors are running per session, fed by `session-kit:monitor:started` and
 * `:stopped` on `pi.events` (`{ sessionId, id, name, todos? }`). A running monitor wakes the parent
 * on its match or exit, so a todo it was started for (`todos`) is waiting at a settle, not held. A
 * monitor without a link arms no todo: it may be unrelated to the held work. Either package works
 * without the other: no session-kit means no events, so nothing is ever reported as armed.
 */

import { MONITOR_STARTED_EVENT } from "../tool/types.ts";

interface Running {
	name: string;
	/** The todo ids the monitor was started for; empty when unlinked, which arms no todo. */
	todos: number[];
}

const sessions = new Map<string, Map<string, Running>>();

/** Record one monitor lifecycle event, `started` or `stopped`; malformed payloads are ignored. */
export function applyMonitorEvent(channel: string, payload: unknown): void {
	if (!payload || typeof payload !== "object") return;
	const { sessionId, id, name, todos } = payload as Record<string, unknown>;
	if (typeof sessionId !== "string" || typeof id !== "string" || !id) return;
	if (channel === MONITOR_STARTED_EVENT) {
		const running = sessions.get(sessionId) ?? new Map<string, Running>();
		const linked = Array.isArray(todos) ? todos : [];
		const links = linked.filter((t): t is number => Number.isSafeInteger(t) && t >= 1);
		running.set(id, { name: typeof name === "string" && name ? name : id, todos: links });
		sessions.set(sessionId, running);
		return;
	}
	const running = sessions.get(sessionId);
	running?.delete(id);
	if (running?.size === 0) sessions.delete(sessionId);
}

/** Running monitors of `sessionId` by the todo id they were started for; the first named wins. */
export function monitorsByTodo(sessionId: string): Map<number, string> {
	const byTodo = new Map<number, string>();
	for (const { name, todos } of sessions.get(sessionId)?.values() ?? [])
		for (const todo of todos) if (!byTodo.has(todo)) byTodo.set(todo, name);
	return byTodo;
}

/**
 * Keep only the links of `sessionId`'s monitors for which `keep(todoId)` holds. A todo id can be
 * reused after `todo clear` (ids restart at 1) or a tree navigation, and a surviving link would arm
 * an unrelated todo.
 */
export function keepLinks(sessionId: string, keep: (todo: number) => boolean): void {
	for (const running of sessions.get(sessionId)?.values() ?? []) running.todos = running.todos.filter(keep);
}

/** Drop everything `sessionId` tracked; called when that session shuts down. */
export function forgetMonitors(sessionId: string): void {
	sessions.delete(sessionId);
}

/** Test-only: forget every tracked monitor. */
export function __resetMonitors(): void {
	sessions.clear();
}
