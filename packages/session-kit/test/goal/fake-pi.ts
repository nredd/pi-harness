// biome-ignore-all lint/suspicious/noExplicitAny: test doubles stand in for pi's large runtime types
/** A fake `pi` + `ctx` pair: records registrations and drives handlers like the runner does. */

import { vi } from "vitest";

type Handler = (event: any, ctx: any) => unknown;

export interface FakeEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

export class FakeBus {
	private handlers = new Map<string, Set<(data: unknown) => void>>();
	on(event: string, handler: (data: unknown) => void): () => void {
		const set = this.handlers.get(event) ?? new Set();
		set.add(handler);
		this.handlers.set(event, set);
		return () => set.delete(handler);
	}
	emit(event: string, data: unknown): void {
		for (const handler of this.handlers.get(event) ?? []) handler(data);
	}
	listenerCount(): number {
		return [...this.handlers.values()].reduce((n, set) => n + set.size, 0);
	}
}

export interface FakeOptions {
	sessionName?: string;
	sessionId?: string;
	entries?: FakeEntry[];
	idle?: boolean;
	pending?: boolean;
	mode?: string;
	activeTools?: string[];
}

export function fakePi(options: FakeOptions = {}) {
	const handlers = new Map<string, Handler[]>();
	const entries: FakeEntry[] = options.entries ?? [];
	const state = {
		sessionName: options.sessionName,
		sessionId: options.sessionId ?? "session-A",
		idle: options.idle ?? true,
		pending: options.pending ?? false,
		activeTools: options.activeTools ?? ["read", "bash"],
	};
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const tools = new Map<string, any>();
	const notices: { message: string; type?: string }[] = [];
	const status = new Map<string, string | undefined>();
	const sent: { text: string; options?: unknown }[] = [];
	const events = new FakeBus();

	const pi: any = {
		events,
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
		registerCommand: (name: string, opts: { handler: (args: string, ctx: any) => Promise<void> }) => {
			commands.set(name, opts.handler);
		},
		registerShortcut: vi.fn(),
		registerTool: (tool: any) => {
			tools.set(tool.name, tool);
			if (tool.exposure === "hidden") state.activeTools = state.activeTools.filter((name) => name !== tool.name);
		},
		appendEntry: (customType: string, data: unknown) => {
			entries.push({ type: "custom", customType, data });
		},
		getSessionName: () => state.sessionName,
		getActiveTools: () => [...state.activeTools],
		setActiveTools: vi.fn((names: string[]) => {
			state.activeTools = names.filter((name) => tools.get(name)?.exposure !== "hidden");
		}),
		sendUserMessage: vi.fn((text: string, opts?: unknown) => {
			sent.push({ text, options: opts });
		}),
	};

	const ctx: any = {
		mode: options.mode ?? "tui",
		hasUI: true,
		ui: {
			notify: (message: string, type?: string) => notices.push({ message, type }),
			setStatus: (key: string, text: string | undefined) => status.set(key, text),
		},
		sessionManager: { getBranch: () => entries, getSessionId: () => state.sessionId },
		isIdle: () => state.idle,
		hasPendingMessages: () => state.pending,
	};

	/** Fire an event; settle/turn_end style results are folded into the event as the runner does. */
	async function emit(name: string, event: Record<string, unknown> = {}, context = ctx): Promise<any> {
		const full: any = { type: name, ...event };
		let result: any;
		for (const handler of handlers.get(name) ?? []) {
			const out = (await handler(full, context)) as { entries?: unknown[]; continue?: boolean } | undefined;
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

	return { pi, ctx, state, entries, commands, tools, notices, status, sent, events, emit, settle, turnEnd, handlers };
}

export type Fake = ReturnType<typeof fakePi>;

/** Mark Plan mode on or off the way pi-plan-mode does: a persisted state entry. */
export function setPlanMode(fake: Fake, enabled: boolean): void {
	fake.entries.push({ type: "custom", customType: "plan-mode-state", data: { enabled } });
}

export const CONFIG = {} as any;
