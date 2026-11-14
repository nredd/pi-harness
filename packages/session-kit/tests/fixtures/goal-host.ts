/**
 * A recording `pi` + `ctx` pair for the goal and loop handlers: the shared doubles from
 * `@nredd/pi-test-lib/pi`, with session state the tests flip (`state`) and the runner's habit of
 * folding settle and turn_end results into the next event.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createRecordingContext,
	createRecordingPi,
	expectNoSubscriberErrors,
	type RecordingPi,
} from "@nredd/pi-test-lib/pi";
import { afterEach } from "vitest";

const created: RecordingPi[] = [];
afterEach(() => {
	expectNoSubscriberErrors(created.splice(0));
});

export interface FakeEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

export interface FakeOptions {
	sessionName?: string;
	sessionId?: string;
	entries?: FakeEntry[];
	idle?: boolean;
	pending?: boolean;
	mode?: "tui" | "rpc" | "json" | "print";
	activeTools?: string[];
}

export function createGoalHost(options: FakeOptions = {}) {
	const entries: FakeEntry[] = options.entries ?? [];
	const state = {
		sessionName: options.sessionName,
		sessionId: options.sessionId ?? "session-A",
		idle: options.idle ?? true,
		pending: options.pending ?? false,
	};
	const recording = createRecordingPi({
		activeTools: options.activeTools ?? ["read", "bash"],
		autoActivate: false,
		overrides: {
			getSessionName: () => state.sessionName,
			appendEntry: (customType: string, data?: unknown) => {
				entries.push({ type: "custom", customType, data });
			},
		},
	});
	created.push(recording);
	const context = createRecordingContext({
		hasUI: true,
		mode: options.mode ?? "tui",
		overrides: {
			sessionManager: {
				getBranch: () => entries,
				getSessionId: () => state.sessionId,
			} as never,
			isIdle: () => state.idle,
			hasPendingMessages: () => state.pending,
		},
	});
	const { ctx } = context;

	/** Fire an event; settle/turn_end style results are folded into the event as the runner does. */
	// biome-ignore lint/suspicious/noExplicitAny: the folded result is shaped per event, and the tests read it untyped
	async function emit(name: string, event: Record<string, unknown> = {}, target = ctx): Promise<any> {
		const full: Record<string, unknown> = { type: name, ...event };
		let result: Record<string, unknown> | undefined;
		for (const handler of recording.handlers.get(name) ?? []) {
			const out = (await handler(full, target)) as { entries?: unknown[]; continue?: boolean } | undefined;
			if (out && typeof out === "object") {
				result = { ...result, ...out };
				if (out.entries) full.entries = out.entries;
				if (out.continue !== undefined) full.continue = out.continue;
			}
		}
		return result;
	}

	/** An `agent_before_settle` event shaped like pi's. */
	function settle(overrides: Record<string, unknown> = {}) {
		return emit("agent_before_settle", {
			entries: [],
			continue: false,
			outcome: "completed",
			context: { canContinue: false, pendingMessages: [], llmMessages: [{ role: "user" }, { role: "assistant" }] },
			...overrides,
		});
	}

	function turnEnd(usage: Record<string, number> = { input: 100, output: 20, cacheWrite: 0 }) {
		return emit("turn_end", { message: { role: "assistant", usage } });
	}

	return {
		pi: recording.pi,
		recording,
		ctx,
		state,
		entries,
		/** Slash command handlers by name. */
		get commands() {
			return new Map([...recording.commands].map(([name, command]) => [name, command.handler]));
		},
		tools: recording.tools,
		/** A registered tool, failing loudly when it is not. */
		tool(name: string): ToolDefinition & { exposure?: string; defaultActive?: boolean } {
			const tool = recording.tools.get(name);
			if (!tool) throw new Error(`tool ${name} not registered`);
			return tool;
		},
		handlers: recording.handlers,
		events: recording.bus,
		status: context.statuses,
		/** `ui.notify` calls, with the level as `type`. */
		get notices() {
			return context.notifications.map(({ message, level }) => ({ message, type: level }));
		},
		/** `sendUserMessage` calls, with the content as `text`. */
		get sent() {
			return recording.sentUserMessages.map(({ content, options: sendOptions }) => ({
				text: content as string,
				options: sendOptions,
			}));
		},
		/** Forget the `sendUserMessage` calls so far. */
		clearSent: () => {
			recording.sentUserMessages.length = 0;
		},
		/** Set the active tool names directly, as the host does outside `setActiveTools`. */
		setActive: (names: string[]) => recording.setActive(names),
		get activeTools() {
			return recording.activeTools;
		},
		emit,
		settle,
		turnEnd,
		shortcuts: recording.shortcuts,
	};
}

export type Fake = ReturnType<typeof createGoalHost>;
export type { RecordingPi };

/** Mark Plan mode on or off the way pi-plan-mode does: a persisted state entry. */
export function setPlanMode(fake: Fake, enabled: boolean): void {
	fake.entries.push({ type: "custom", customType: "plan-mode-state", data: { enabled } });
}

export const CONFIG = {} as never;
