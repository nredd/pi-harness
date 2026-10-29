/** Real-session fixtures shared by the Vitest and Bun scenario suites. No fake Pi or live config. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionFactory, type ExtensionUIContext, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	createHarness,
	createTestUiContext,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
	getMessageText,
	type Harness,
	type HarnessOptions,
} from "@earendil-works/pi-coding-agent/testing";
import {
	createInteractiveHarness,
	type InteractiveHarness,
	type InteractiveHarnessOptions,
} from "@earendil-works/pi-coding-agent/testing/interactive";
import { StdinBuffer } from "@earendil-works/pi-tui";
import type { Clock, TimerHandle } from "../../src/clock.ts";
import { defaultConfig, type Feature, type KitConfig } from "../../src/config.ts";
import { GOAL_ENTRY, GOAL_NUDGE_TYPE, type GoalSnapshot } from "../../src/goal/state.ts";
import { createSessionKit, type SessionKitOptions } from "../../src/index.ts";
import type { ExitInfo, MonitorProcess, SpawnOptions } from "../../src/monitor/process.ts";

export const EVIDENCE = "uv run pytest tests: 12 passed";
export const WIDTHS = [60, 80, 120, 160, 200, 240, 320];
export const RESIZES = [
	[60, 24],
	[320, 60],
	[80, 30],
	[240, 50],
	[60, 40],
] as const;
export const STATUS = "STATUS-LINE-OK";

/** Enable only the features under test, without reading the user's agent directory. */
export function configFor(...features: Feature[]): KitConfig {
	const config = defaultConfig();
	for (const feature of Object.keys(config.features) as Feature[])
		config.features[feature] = features.includes(feature);
	return config;
}

/** Scratch workspace with file-backed sessions and explicitly configured real kit factories. */
export class ScenarioFixture {
	readonly root = mkdtempSync(join(tmpdir(), "pi-kit-scenario-"));
	readonly sessions = join(this.root, "sessions");
	readonly agentDir = join(this.root, "agent");
	private harnesses: Harness[] = [];

	/** Build and bind a fresh real session, or reopen a caller-supplied manager. */
	async start(
		config: KitConfig,
		options: HarnessOptions & { kit?: SessionKitOptions; ui?: Partial<ExtensionUIContext> } = {},
	): Promise<Harness> {
		const { kit, ui, ...host } = options;
		const harness = await createHarness({
			cwd: this.root,
			sessionManager: SessionManager.create(this.root, this.sessions),
			settings: { retry: { enabled: false } },
			extensionFactories: [
				createSessionKit({ config, agentDir: this.agentDir, monitorRoot: join(this.root, "monitors"), ...kit }),
			],
			...host,
		});
		this.harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "print", uiContext: createTestUiContext(ui) });
		return harness;
	}

	/** Deliver the host shutdown lifecycle before disposal; core's synchronous dispose does not emit it. */
	async shutdown(): Promise<void> {
		for (const harness of this.harnesses)
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	}

	/** Dispose sessions before deleting caller-owned files. Safe after an earlier harness cleanup. */
	cleanup(): void {
		for (const harness of this.harnesses.reverse()) harness.cleanup();
		this.harnesses = [];
		rmSync(this.root, { recursive: true, force: true });
	}
}

/** Real interactive host with an observed (not replaced) overlay mount and deterministic kit clock. */
export class TerminalFixture extends ScenarioFixture {
	readonly clock = new FakeClock(Date.parse("2026-10-18T12:00:00Z"));
	host: InteractiveHarness | undefined;
	private mounted: ReturnType<typeof deferred<void>> | undefined;
	private command: Promise<void> | undefined;

	/** Mount the real editor, footer and extension UI. Histories/config remain under this scratch root. */
	async startTerminal(config: KitConfig, options: InteractiveHarnessOptions = {}): Promise<InteractiveHarness> {
		const observe: ExtensionFactory = (pi) => {
			pi.on("session_start", (_event, ctx) => {
				ctx.ui.setStatus("fixture", STATUS);
				const custom = ctx.ui.custom.bind(ctx.ui);
				ctx.ui.custom = (factory, opts) =>
					custom((...args) => {
						const component = factory(...args);
						this.mounted?.resolve();
						return component;
					}, opts);
			});
		};
		this.host = await createInteractiveHarness({
			cwd: this.root,
			columns: 120,
			rows: 40,
			sessionManager: SessionManager.create(this.root, this.sessions),
			settings: { retry: { enabled: false } },
			...options,
			extensionFactories: [
				createSessionKit({ config, agentDir: this.agentDir, clock: this.clock }),
				observe,
				...(options.extensionFactories ?? []),
			],
		});
		// VirtualTerminal sends chunks verbatim; ProcessTerminal uses this parser before TUI input.
		// Flush incomplete input because fixture calls supply whole keys (including a lone Escape).
		const input = this.host.input;
		const parser = new StdinBuffer();
		parser.on("data", input);
		this.host.input = (data) => {
			parser.process(data);
			for (const sequence of parser.flush()) input(sequence);
		};
		return this.host;
	}

	/** Wait for the real custom factory to mount, rather than polling terminal frames or sleeping. */
	async open(command: string, raw = false): Promise<void> {
		const host = this.requireHost();
		this.mounted = deferred<void>();
		if (raw) {
			host.input(command);
			host.input("\r");
			await this.mounted.promise;
			await host.settle();
			return;
		}
		this.command = host.harness.session.prompt(command);
		const outcome = await Promise.race([
			this.mounted.promise.then(() => "mounted"),
			this.command.then(() => "finished"),
		]);
		if (outcome !== "mounted") throw new Error(`No overlay for ${command}`);
		await host.settle();
	}

	/** Deliver raw terminal input and flush the real host scheduler without advancing wall time. */
	async key(data: string): Promise<void> {
		const host = this.requireHost();
		host.input(data);
		this.clock.advance(0);
		await host.settle();
	}

	/** Close the overlay and wait for the command that owned it to return. */
	async close(key = "q"): Promise<void> {
		await this.key(key);
		await this.command;
		this.command = undefined;
		await this.requireHost().settle();
	}

	/** Complete real host disposal before removing file-backed sessions. */
	async dispose(): Promise<void> {
		await this.host?.dispose();
		this.cleanup();
	}

	/** Reject accidental use before startup. */
	requireHost(): InteractiveHarness {
		if (!this.host) throw new Error("Terminal fixture has not started");
		return this.host;
	}
}

/** One scripted model tool request, executed by the real host. */
export function tool(name: string, args: Parameters<typeof fauxToolCall>[1]) {
	return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

/** Completion with evidence, shared by the goal continuation scenarios. */
export function complete(evidence = EVIDENCE) {
	return tool("goal_update", { status: "complete", evidence });
}

/** Persisted goal snapshots in branch order, including explicit clears. */
export function goalStates(harness: Harness) {
	return harness.sessionManager
		.getBranch()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === GOAL_ENTRY ? [(entry.data as GoalSnapshot).goal] : [],
		);
}

/** Hidden goal messages as committed by the host settle path, not synthetic extension events. */
export function nudges(harness: Harness) {
	return harness.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom_message" && entry.customType === GOAL_NUDGE_TYPE);
}

/** Newly emitted assistant prose, excluding restored history and tool-call-only responses. */
export function spoken(harness: Harness): string[] {
	return harness
		.eventsOfType("message_end")
		.filter((event) => event.message.role === "assistant")
		.map((event) => getMessageText(event.message))
		.filter(Boolean);
}

/** Tool results as persisted after extension tool_result hooks (including injected rules). */
export function outcomes(harness: Harness, name: string) {
	return harness.session.messages.flatMap((message) =>
		message.role === "toolResult" && message.toolName === name
			? [{ isError: message.isError, text: getMessageText(message) }]
			: [],
	);
}

/** Require a session file rather than silently testing an in-memory restore. */
export function sessionFile(harness: Harness): string {
	const file = harness.sessionManager.getSessionFile();
	if (!file) throw new Error("Expected a file-backed session");
	return file;
}

/** Deterministic timer queue: advance executes production callbacks, including cancellation/rearming. */
export class FakeClock implements Clock {
	constructor(private time = 1_700_000_000_000) {}
	private nextId = 0;
	private timers = new Map<number, { at: number; interval?: number; callback: () => void }>();

	now(): number {
		return this.time;
	}

	setTimeout(callback: () => void, ms: number): TimerHandle {
		return this.schedule(callback, ms);
	}

	setInterval(callback: () => void, ms: number): TimerHandle {
		return this.schedule(callback, ms, ms);
	}

	/** Number of live timers, useful for proving stop/shutdown canceled scheduling. */
	get pending(): number {
		return this.timers.size;
	}

	/** Run all callbacks due in the next `ms`, in deadline/insertion order, without sleeping. */
	advance(ms: number): void {
		const end = this.time + ms;
		for (;;) {
			const due = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) break;
			const [id, timer] = due;
			this.time = timer.at;
			if (timer.interval === undefined) this.timers.delete(id);
			else timer.at += timer.interval;
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

/** Promise gate for holding a real faux provider request or observing a host lifecycle event. */
export function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve: (value: T) => resolve(value) };
}

/** Hold a real provider request until explicitly released, without any elapsed time. */
export function heldResponse(text: string) {
	const entered = deferred<void>();
	const released = deferred<void>();
	const response: FauxResponseFactory = async () => {
		entered.resolve();
		await released.promise;
		return fauxAssistantMessage(text);
	};
	return { response, entered: entered.promise, release: () => released.resolve() };
}

/** One actual host event, subscribed before an action (never a poll or elapsed-clock wait). */
export function nextEvent(harness: Harness, type: "agent_settled" | "agent_start"): Promise<void> {
	return new Promise((resolve) => {
		const off = harness.session.subscribe((event) => {
			if (event.type !== type) return;
			off();
			resolve();
		});
	});
}

/** Advance a timer expected to start a turn, then wait for the real host to settle that turn. */
export async function tick(harness: Harness, clock: FakeClock, ms = 30_000): Promise<void> {
	const settled = nextEvent(harness, "agent_settled");
	clock.advance(ms);
	await settled;
	await harness.session.waitForIdle();
}

/** Advance a timer that must not wake the host, including asynchronously scheduled turns. */
export async function advanceQuietly(harness: Harness, clock: FakeClock, ms: number): Promise<void> {
	let started = false;
	const off = harness.session.subscribe((event) => {
		if (event.type === "agent_start") started = true;
	});
	try {
		clock.advance(ms);
		for (let turn = 0; turn < 3; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
		await harness.session.waitForIdle();
	} finally {
		off();
	}
	if (started) throw new Error("quiet timer started an agent turn");
}

/** Controlled child only: the real manager still owns splitting, matching, batching and lifecycle. */
export class ControlledProcess implements MonitorProcess {
	readonly exited: Promise<ExitInfo>;
	readonly terminations: number[] = [];
	kills = 0;
	alive = true;
	private readonly exitGate = deferred<ExitInfo>();

	constructor(
		readonly pid: number,
		readonly startedAt: number,
		private readonly options: SpawnOptions,
		readonly identity = `controlled-${pid}`,
	) {
		this.exited = this.exitGate.promise;
	}

	/** Feed complete or partial stdout bytes and await real matching/ingestion, not a test matcher. */
	async stdout(text: string): Promise<void> {
		await this.options.onStdout(Buffer.from(text));
	}

	/** Complete the controlled child's output stream with an exact OS-shaped exit value. */
	exit(exitCode: number | null, signal: NodeJS.Signals | null = null): void {
		this.alive = false;
		this.exitGate.resolve({ exitCode, signal });
	}

	terminate(graceMs = 2_000): void {
		this.terminations.push(graceMs);
		this.exit(null, "SIGTERM");
	}

	killNow(): void {
		this.kills++;
		this.exit(null, "SIGKILL");
	}
}

/** Records spawn inputs and lifetime requests. Missing binaries reject like the native spawn seam. */
export class ControlledProcesses {
	readonly children: ControlledProcess[] = [];
	readonly calls: { argv: readonly string[]; cwd: string }[] = [];

	constructor(private readonly clock: Clock) {}

	readonly spawn = async (argv: readonly string[], options: SpawnOptions): Promise<MonitorProcess> => {
		this.calls.push({ argv, cwd: options.cwd });
		if (argv[0] === "/nonexistent/binary") throw new Error("spawn /nonexistent/binary ENOENT");
		const child = new ControlledProcess(900_000 + this.children.length, this.clock.now(), options);
		this.children.push(child);
		return child;
	};

	/** Require the last successful spawn rather than silently skipping assertions on a missing child. */
	get last(): ControlledProcess {
		const child = this.children.at(-1);
		if (!child) throw new Error("Expected a spawned monitor");
		return child;
	}
}
