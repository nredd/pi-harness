/** Real core host and deterministic ports shared by Vitest and Bun footer scenarios. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionFactory, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-coding-agent/testing";
import {
	createInteractiveHarness,
	type InteractiveHarness,
	type InteractiveHarnessOptions,
} from "@earendil-works/pi-coding-agent/testing/interactive";
import { createExpandedFooter, type FooterClock, type TimerHandle } from "../../extensions/expanded-footer.ts";
import { USAGE_CHANNEL } from "../../lib/footer-quota.ts";

export const STATUS = "STATUS-LINE-OK";
export const WIDTHS = [60, 80, 120, 160, 200, 240, 320];

/** Advancing runs production callbacks in deadline/insertion order, never wall-clock sleeps. */
export class FakeClock implements FooterClock {
	private time = Date.parse("2026-10-19T12:00:00Z");
	private nextId = 0;
	private timers = new Map<number, { at: number; interval?: number; callback: () => void }>();
	readonly fired: number[] = [];
	now(): number {
		return this.time;
	}

	setTimeout(callback: () => void, ms: number): TimerHandle {
		return this.schedule(callback, ms);
	}

	setInterval(callback: () => void, ms: number): TimerHandle {
		return this.schedule(callback, ms, ms);
	}

	/** Live timers prove shutdown and one-shot expiry leave no scheduling behind. */
	get pending(): number {
		return this.timers.size;
	}

	/** Execute due callbacks, including rearming/cancellation, on this single clock. */
	advance(ms: number): void {
		const end = this.time + ms;
		for (;;) {
			const due = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) break;
			const [id, timer] = due;
			this.time = timer.at;
			if (timer.interval === undefined) this.timers.delete(id);
			else timer.at += timer.interval;
			this.fired.push(id);
			timer.callback();
		}
		this.time = end;
	}

	private schedule(callback: () => void, ms: number, interval?: number): TimerHandle {
		const id = ++this.nextId;
		this.timers.set(id, { at: this.time + ms, interval, callback });
		return {
			cancel: () => {
				this.timers.delete(id);
			},
		};
	}
}

/** Router-shaped usage snapshot, with provider-scoped names and unknown-provider validation. */
export function snapshot(
	provider: string,
	used: readonly [number, number] | undefined,
	now: number,
	status = "available",
) {
	const names =
		provider === "anthropic" ? ["five_hour", "seven_day"] : provider === "openai-codex" ? ["5h", "7d"] : undefined;
	if (!names) throw new Error(`Unknown provider: ${provider}`);
	return {
		provider,
		status,
		expiresAt: now + 3_600_000,
		windows: used ? names.map((name, i) => ({ name, scope: "provider", usedPercent: used[i] })) : [],
	};
}

/** Usage-bus double only; the real footer owns parsing, polling, timeout and stale recovery. */
export class UsageBus {
	anthropic: readonly [number, number] | undefined = [20, 40];
	codex: readonly [number, number] | undefined = [30, 50];
	statuses: [string, string] = ["available", "available"];
	mode: "ok" | "hang" | "error" = "ok";
	ready = false;
	requests: { at: number; ready: boolean; refresh: unknown; reply: (body?: unknown) => void }[] = [];
	readonly clock: FakeClock;
	constructor(clock: FakeClock) {
		this.clock = clock;
	}

	/** Omit absent providers entirely, as the router does, instead of inventing windows. */
	envelope(): unknown {
		return {
			success: true,
			data: {
				snapshots: [
					...(this.anthropic ? [snapshot("anthropic", this.anthropic, this.clock.now(), this.statuses[0])] : []),
					...(this.codex ? [snapshot("openai-codex", this.codex, this.clock.now(), this.statuses[1])] : []),
				],
				blocks: [],
			},
		};
	}

	/** Attach to Pi's real event bus and mark readiness in the later startup handler. */
	private emit: ((channel: string, body: unknown) => void) | undefined;
	readonly extension: ExtensionFactory = (pi) => {
		this.emit = (channel, body) => pi.events.emit(channel, body);
		const off = pi.events.on(USAGE_CHANNEL, (raw: unknown) => {
			const request = raw as { requestId: string; refresh?: unknown };
			const reply = (body: unknown = this.envelope()) =>
				this.emit?.(`${USAGE_CHANNEL}:reply:${request.requestId}`, body);
			this.requests.push({ at: this.clock.now(), ready: this.ready, refresh: request.refresh, reply });
			if (this.mode === "ok") reply();
			else if (this.mode === "error") reply({ success: false, error: "fixture failure" });
		});
		pi.on("session_start", (_event, ctx) => {
			this.ready = true;
			ctx.ui.setStatus("fixture", STATUS);
		});
		pi.on("session_shutdown", () => {
			this.ready = false;
			off();
		});
	};
}

export interface Turn {
	age: number;
	read: number;
	input: number;
	write?: number;
	model?: string;
}
export const WARM: Turn[] = [
	{ age: 60, read: 0, input: 100, write: 3000 },
	{ age: 5, read: 3000, input: 100 },
];
export const COLD: Turn[] = [
	{ age: 3700, read: 0, input: 100, write: 3000 },
	{ age: 3600, read: 3000, input: 100 },
];
export const DROP_WARM: Turn[] = [
	{ age: 60, read: 3000, input: 100 },
	{ age: 5, read: 0, input: 3100 },
];
export const DROP_COLD: Turn[] = [
	{ age: 3700, read: 3000, input: 100 },
	{ age: 3600, read: 0, input: 3100 },
];
export const DROP_IDLE: Turn[] = [
	{ age: 2000, read: 3000, input: 100 },
	{ age: 5, read: 0, input: 3100 },
];
export const DROP_SWITCH: Turn[] = [
	{ age: 60, read: 3000, input: 100 },
	{ age: 5, read: 0, input: 3100, model: "alt" },
];

/** Caller-owned scratch history and one real interactive host. */
export class FooterFixture {
	readonly root = realpathSync(mkdtempSync(join(tmpdir(), "pi-footer-")));
	readonly clock = new FakeClock();
	readonly usage = new UsageBus(this.clock);
	host: InteractiveHarness | undefined;

	/** Persist the live scenarios' history through SessionManager, then mount the real footer. */
	async start(
		options: InteractiveHarnessOptions & {
			turns?: Turn[];
			name?: string;
			compaction?: boolean;
			ttl?: number;
			absent?: boolean;
			deferStart?: boolean;
		} = {},
	): Promise<InteractiveHarness> {
		const { turns = [], name, compaction, ttl, absent, deferStart, ...hostOptions } = options;
		const cwd = hostOptions.cwd ?? join(this.root, "project");
		mkdirSync(cwd, { recursive: true });
		const manager = SessionManager.create(cwd, join(this.root, "sessions"));
		if (name) manager.appendSessionInfo(name);
		let first: string | null = null;
		for (const [i, turn] of turns.entries()) {
			if (compaction && i === turns.length - 1) manager.appendCompaction("s", first, 1);
			const at = this.clock.now() - turn.age * 1000;
			const id = manager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `q${i}` }],
				timestamp: at - 1000,
			});
			first ??= id;
			const message = fauxAssistantMessage(`reply ${i}`, { timestamp: at });
			message.model = turn.model ?? "main";
			message.provider = "faux";
			message.usage = {
				input: turn.input,
				output: 20,
				cacheRead: turn.read,
				cacheWrite: turn.write ?? 0,
				totalTokens: turn.input + turn.read + (turn.write ?? 0) + 20,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.004 },
			};
			manager.appendMessage(message);
		}
		const file = manager.getSessionFile();
		this.host = await createInteractiveHarness({
			cwd,
			columns: 120,
			rows: 40,
			models: [{ id: "main" }, { id: "alt" }],
			sessionManager: file && turns.length ? SessionManager.open(file) : manager,
			...hostOptions,
			extensionFactories: [
				createExpandedFooter({ clock: this.clock }),
				...(absent ? [] : [this.usage.extension]),
				...(hostOptions.extensionFactories ?? []),
			],
		});
		if (ttl !== undefined)
			await this.host.harness.session.setModel({ ...this.host.harness.getModel(), promptCache: { short: ttl } });
		await this.host.settle();
		if (!deferStart) await this.advance(0);
		return this.host;
	}

	/** Advance extension time, then flush real renderer scheduling and xterm writes. */
	async advance(ms: number): Promise<void> {
		this.clock.advance(ms);
		await this.requireHost().settle();
	}

	/** Require a mounted host rather than silently omitting assertions. */
	requireHost(): InteractiveHarness {
		if (!this.host) throw new Error("Footer host not started");
		return this.host;
	}

	/** Real lifecycle disposal before removing caller-owned session files. */
	async dispose(): Promise<void> {
		await this.host?.dispose();
		rmSync(this.root, { recursive: true, force: true });
	}
}

/** One on-screen quota row; duplicates fail instead of hiding leaked/wrapped output. */
export function quotaRow(host: InteractiveHarness): string {
	const rows = host.viewport().filter((row) => /^\s*(Quota left:|Left:)/.test(row));
	if (rows.length !== 1) throw new Error(`Expected one quota row: ${host.viewport().join("\n")}`);
	return rows[0] ?? "";
}

/** Provider segment from either rendered tier. */
export function providerSegment(host: InteractiveHarness, provider: "anthropic" | "openai-codex"): string {
	const row = quotaRow(host);
	const match = row.match(provider === "anthropic" ? /(?:Anthropic|Anth) (.*?)(?:\s*\||$)/ : /(?:OpenAI|OAI) (.*)$/);
	if (!match) throw new Error(`Missing ${provider}: ${row}`);
	return match[1] ?? "";
}

/** Displayed window values, not poller internals. */
export function values(host: InteractiveHarness, provider: "anthropic" | "openai-codex"): string[] {
	return [...providerSegment(host, provider).matchAll(/(\d+%|--)/g)].map((match) => match[0]);
}

/** A promise gate, used for pending real faux requests with no elapsed wall time. */
export function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve: (value: T) => resolve(value) };
}
