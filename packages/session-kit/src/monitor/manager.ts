/**
 * Per-session monitor registry. One instance per pi session: it owns every child it spawned, kills
 * them all on `dispose()`, and never looks at another session's state (the pidfile sweep, which does
 * look at other session directories, lives in `pidfiles.ts` and only touches dead owners).
 */

import { join } from "node:path";
import { type Clock, realClock, type TimerHandle } from "../clock.ts";
import { type CoalescedBatch, Coalescer } from "./coalescer.ts";
import { BoundedMatcher } from "./matcher.ts";
import { formatMessage, type TaggedLine } from "./messages.ts";
import {
	rootDir as defaultRootDir,
	type PidRecord,
	removePidfile,
	removeSessionDirIfEmpty,
	sessionDirName,
	writePidfile,
} from "./pidfiles.ts";
import { type ExitInfo, KILL_GRACE_MS, type MonitorProcess, spawnMonitor } from "./process.ts";
import { RingBuffer, type RingRead } from "./ring.ts";
import { LineSplitter } from "./splitter.ts";
import type { MonitorInfo, MonitorMessage, MonitorStatus } from "./types.ts";
import { type StartParams, type ValidStart, validateStart } from "./validate.ts";

export const COALESCE_MS = 2_000;
const RETAINED_FINISHED = 10;

export interface ManagerOptions {
	sessionId: string;
	/** Called once per coalesced batch / lifecycle event. Must not throw. */
	send: (message: MonitorMessage) => void;
	/** Called whenever the set or state of monitors changes (widget refresh). */
	onChange?: () => void;
	root?: string;
	ownerPid?: number;
	coalesceMs?: number;
	killGraceMs?: number;
	clock?: Clock;
	spawnMonitor?: typeof spawnMonitor;
}

export class MonitorError extends Error {}

interface Monitor {
	id: string;
	name: string;
	argv: string[];
	cwd: string;
	wake: boolean;
	matcher: BoundedMatcher | undefined;
	matchSource: string | undefined;
	timeoutMs: number;
	startedAt: number;
	endedAt?: number;
	status: MonitorStatus;
	exit: ExitInfo;
	proc: MonitorProcess;
	ring: RingBuffer;
	coalescer: Coalescer<TaggedLine>;
	timeoutTimer: TimerHandle;
	stopReason: "stop" | "timeout" | undefined;
	/** Cursor after the output the model most recently received through a wake or read. */
	notifiedSince: number;
	/** Lines that matched, counted as they are ingested. */
	matches: number;
	/** Resolves after the exit was fully processed (status set, pidfile removed). */
	done: Promise<void>;
}

export class MonitorManager {
	private readonly monitors = new Map<string, Monitor>();
	private readonly sessionDir: string;
	private readonly opts: Required<Pick<ManagerOptions, "coalesceMs" | "killGraceMs" | "ownerPid">> & ManagerOptions;
	/** Names of monitors being spawned right now; reserved so parallel starts cannot exceed the caps. */
	private readonly starting = new Set<string>();
	private readonly clock: Clock;
	private counter = 0;
	private disposed = false;
	private readonly exitBackstop = () => {
		for (const m of this.monitors.values()) if (m.status === "running") m.proc.killNow();
	};

	constructor(opts: ManagerOptions) {
		this.clock = opts.clock ?? realClock;
		this.opts = { coalesceMs: COALESCE_MS, killGraceMs: KILL_GRACE_MS, ownerPid: process.pid, ...opts };
		this.sessionDir = join(opts.root ?? defaultRootDir(), sessionDirName(opts.sessionId, this.opts.ownerPid));
		// SIGKILL cannot be caught (the pidfile sweep covers that), but any other exit path must not leak children.
		process.once("exit", this.exitBackstop);
	}

	list(): MonitorInfo[] {
		return [...this.monitors.values()].map(toInfo);
	}

	running(): MonitorInfo[] {
		return this.list().filter((m) => m.status === "running");
	}

	/** Look up by id, then by name (a running monitor wins over a finished one of the same name). */
	find(idOrName: string): Monitor | undefined {
		const byId = this.monitors.get(idOrName);
		if (byId) return byId;
		const named = [...this.monitors.values()].filter((m) => m.name === idOrName);
		return named.find((m) => m.status === "running") ?? named.at(-1);
	}

	info(idOrName: string): MonitorInfo | undefined {
		const m = this.find(idOrName);
		return m ? toInfo(m) : undefined;
	}

	read(idOrName: string, since?: number): (RingRead & { info: MonitorInfo; lastLine: number }) | undefined {
		const m = this.find(idOrName);
		if (!m) return undefined;
		const lastLine = m.ring.lastLine;
		m.notifiedSince = lastLine;
		return { ...m.ring.read(since), info: toInfo(m), lastLine };
	}

	async start(params: StartParams, cwd: string): Promise<MonitorInfo> {
		if (this.disposed) throw new MonitorError("this session is shutting down");
		const live = this.running();
		const names = new Set([...live.map((m) => m.name), ...this.starting]);
		const checked = validateStart(params, names, live.length + this.starting.size);
		if (!checked.ok) throw new MonitorError(checked.error);
		const { name } = checked.value;
		this.starting.add(name);
		try {
			return await this.spawn(checked.value, params.match, cwd);
		} finally {
			this.starting.delete(name);
		}
	}

	private async spawn(valid: ValidStart, matchSource: string | undefined, cwd: string): Promise<MonitorInfo> {
		const { argv, name, regex, wake, timeoutMs } = valid;
		const id = `m${++this.counter}`;
		const ring = new RingBuffer();
		let monitor: Monitor | undefined;
		const early: string[] = [];
		const onLine = (text: string): Promise<void> => {
			if (monitor) return this.ingest(monitor, text);
			early.push(text);
			return Promise.resolve();
		};
		const consume = async (splitter: LineSplitter, chunk: Buffer): Promise<void> => {
			await Promise.all(splitter.push(chunk).map(onLine));
		};
		const out = new LineSplitter();
		const err = new LineSplitter();
		let proc: MonitorProcess;
		try {
			proc = await (this.opts.spawnMonitor ?? spawnMonitor)(argv, {
				cwd,
				onStdout: (chunk) => consume(out, chunk),
				onStderr: (chunk) => consume(err, chunk),
			});
		} catch (error) {
			throw new MonitorError(`cannot start ${JSON.stringify(argv[0])}: ${(error as Error).message}`);
		}
		if (this.disposed) {
			proc.killNow();
			throw new MonitorError("this session is shutting down");
		}

		const record: PidRecord = {
			ownerPid: this.opts.ownerPid,
			childPid: proc.pid,
			pgid: proc.pid,
			startedAt: proc.startedAt,
			name,
			command: argv.join(" "),
		};
		try {
			writePidfile(this.sessionDir, id, record);
		} catch (error) {
			proc.killNow();
			throw new MonitorError(`cannot record monitor pidfile: ${(error as Error).message}`);
		}

		let matcher: BoundedMatcher | undefined;
		try {
			matcher = regex ? new BoundedMatcher(regex.source) : undefined;
		} catch (error) {
			proc.killNow();
			removePidfile(this.sessionDir, id);
			throw new MonitorError(`cannot start match worker: ${(error as Error).message}`);
		}
		const coalescer = new Coalescer<TaggedLine>(
			this.opts.coalesceMs,
			(batch) => this.emitBatch(monitor as Monitor, batch),
			{ sizeOf: (line) => Buffer.byteLength(line.text), matched: (line) => line.matched },
			this.clock,
		);
		const timeoutTimer = this.clock.setTimeout(() => this.finishRequested(monitor as Monitor, "timeout"), timeoutMs);
		monitor = {
			id,
			name,
			argv,
			cwd,
			wake,
			matcher,
			matchSource: matchSource || undefined,
			timeoutMs,
			startedAt: proc.startedAt,
			status: "running",
			exit: { exitCode: null, signal: null },
			proc,
			ring,
			coalescer,
			timeoutTimer,
			stopReason: undefined,
			notifiedSince: 0,
			matches: 0,
			done: Promise.resolve(),
		};
		const m = monitor;
		m.done = proc.exited.then(async (exit) => {
			out.flush().forEach(onLine);
			err.flush().forEach(onLine);
			await m.matcher?.drain();
			await m.matcher?.close();
			this.onExited(m, exit);
		});
		this.monitors.set(id, m);
		for (const text of early) this.ingest(m, text);
		this.prune();
		this.opts.onChange?.();
		return toInfo(m);
	}

	/** Stop one monitor (id or name) and wait for it to be gone. Returns undefined when unknown. */
	async stop(idOrName: string): Promise<MonitorInfo | undefined> {
		const m = this.find(idOrName);
		if (!m) return undefined;
		if (m.status === "running") this.finishRequested(m, "stop");
		await m.done;
		return toInfo(m);
	}

	async stopAll(): Promise<MonitorInfo[]> {
		const running = [...this.monitors.values()].filter((m) => m.status === "running");
		for (const m of running) this.finishRequested(m, "stop");
		await Promise.all(running.map((m) => m.done));
		return running.map(toInfo);
	}

	/** Kill everything silently (no messages) and forget it. Idempotent. */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const running = [...this.monitors.values()].filter((m) => m.status === "running");
		for (const m of running) {
			m.timeoutTimer.cancel();
			m.coalescer.cancel();
			m.proc.terminate(this.opts.killGraceMs);
			// Interrupt a busy regex immediately, rather than making shutdown wait for its deadline.
			void m.matcher?.close();
		}
		await Promise.all(running.map((m) => m.done));
		for (const m of this.monitors.values()) removePidfile(this.sessionDir, m.id);
		removeSessionDirIfEmpty(this.sessionDir);
		this.monitors.clear();
		process.off("exit", this.exitBackstop);
	}

	private ingest(m: Monitor, text: string): Promise<void> {
		const line = m.ring.push(text);
		return new Promise((resolve) => {
			const add = (matched: boolean) => {
				if (matched) m.matches++;
				m.coalescer.add({ ...line, matched });
				resolve();
			};
			if (m.matcher) m.matcher.test(text, add);
			else add(false);
		});
	}

	private finishRequested(m: Monitor, reason: "stop" | "timeout"): void {
		if (m.status !== "running" || m.stopReason !== undefined) return;
		m.stopReason = reason;
		m.proc.terminate(this.opts.killGraceMs);
	}

	private onExited(m: Monitor, exit: ExitInfo): void {
		m.timeoutTimer.cancel();
		m.exit = exit;
		m.endedAt = this.clock.now();
		m.status = m.stopReason === "timeout" ? "timeout" : m.stopReason === "stop" ? "stopped" : "exited";
		removePidfile(this.sessionDir, m.id);
		const pending = m.coalescer.take();
		if (this.disposed) return;
		// A requested stop is already known to whoever asked. Passive output stays only in the ring;
		// natural exit and timeout each emit one compact wake.
		if (m.stopReason !== "stop") this.deliver(m, pending, { final: true, wake: true });
		this.opts.onChange?.();
	}

	private emitBatch(m: Monitor, batch: CoalescedBatch<TaggedLine>): void {
		if (this.disposed || (batch.items.length === 0 && batch.dropped === 0)) return;
		const wake = m.wake || batch.droppedMatched || batch.items.some((l) => l.matched);
		if (wake) this.deliver(m, batch, { final: false, wake });
	}

	/** A failed delivery must never leave a monitor un-reaped, so it is swallowed here. */
	private deliver(m: Monitor, batch: CoalescedBatch<TaggedLine>, opts: { final: boolean; wake: boolean }): void {
		try {
			this.opts.send(formatMessage(toInfo(m), batch, { ...opts, since: m.notifiedSince }));
			m.notifiedSince = m.ring.lastLine;
		} catch {
			// the output stays readable through monitor_read
		}
	}

	private prune(): void {
		const finished = [...this.monitors.values()].filter((m) => m.status !== "running");
		for (const m of finished.slice(0, Math.max(0, finished.length - RETAINED_FINISHED))) this.monitors.delete(m.id);
	}
}

function toInfo(m: Monitor): MonitorInfo {
	return {
		id: m.id,
		name: m.name,
		argv: m.argv,
		pid: m.proc.pid,
		status: m.status,
		startedAt: m.startedAt,
		endedAt: m.endedAt,
		exitCode: m.exit.exitCode,
		signal: m.exit.signal,
		lines: m.ring.lastLine,
		matches: m.matches,
		lastLine: m.ring.lastText,
		wake: m.wake,
		match: m.matchSource,
		timeoutMs: m.timeoutMs,
	};
}
