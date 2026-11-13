/**
 * Isolate model-provided backtracking regexes from pi's event loop. One child per matching monitor,
 * supervising a worker so IPC disconnect remains responsive even during catastrophic backtracking.
 * One line in flight, 100ms per test (excluding worker startup, which has a 1s deadline). Queued
 * text plus per-item overhead is capped at 256KiB; final draining is bounded to 1s. On timeout, overflow or worker failure, disable matching for this monitor
 * and conservatively mark pending/future lines matched: output still wakes rather than losing alerts.
 * Normal tests retain JS RegExp semantics and line ordering. close() kills and reaps the child
 * (including its worker); drain() waits for queued callbacks before the monitor's final output is delivered.
 * Every deadline runs on the injected `Clock`, the manager's, so a scheduler-controlled clock decides
 * when a worker counts as late rather than how loaded the host happens to be.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { type Clock, realClock, type TimerHandle } from "../clock.ts";

export const MATCH_TIMEOUT_MS = 100;
export const MATCH_QUEUE_BYTES = 256 * 1024;
const STARTUP_TIMEOUT_MS = 1000;
// Keep the child event loop free to observe parent death even while a regex spins. Killing the
// process interrupts its worker without calling the engine-dependent Worker.terminate() API.
const REGEX_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const regex = new RegExp(workerData);
parentPort.on('message', text => parentPort.postMessage(regex.test(text)));
`;
const SOURCE = `
const { Worker } = require('node:worker_threads');
const worker = new Worker(${JSON.stringify(REGEX_SOURCE)}, { eval: true, workerData: JSON.parse(process.argv[1]) });
worker.once('online', () => process.send('ready'));
worker.on('message', matched => process.send(matched));
worker.on('error', () => process.exit(1));
process.on('message', text => worker.postMessage(text));
process.on('disconnect', () => process.kill(process.pid, 'SIGKILL'));
`;

interface Pending {
	text: string;
	bytes: number;
	done: (matched: boolean) => void;
}

export class BoundedMatcher {
	private worker: ChildProcess | undefined;
	private ready = false;
	private active: Pending | undefined;
	private readonly queue: Pending[] = [];
	private bytes = 0;
	private timer: TimerHandle | undefined;
	private readonly drained: (() => void)[] = [];
	private termination: Promise<unknown> = Promise.resolve();

	constructor(
		source: string,
		private readonly clock: Clock = realClock,
	) {
		this.worker = spawn(process.execPath, ["-e", SOURCE, JSON.stringify(source)], {
			stdio: ["ignore", "ignore", "ignore", "ipc"],
			// A compiled Bun host must act as an interpreter, not re-enter its bundled Pi entrypoint.
			// https://bun.com/docs/bundler/executables#act-as-the-bun-cli
			env: { ...process.env, BUN_BE_BUN: "1" },
		});
		const worker = this.worker;
		this.termination = new Promise<void>((resolve) => {
			const finished = () => {
				this.disable();
				resolve();
			};
			// Reaping is complete at exit; Node may omit close after an explicit IPC disconnect.
			// Failed spawns have no exit event, so also handle close.
			worker.once("exit", finished);
			worker.once("close", finished);
		});
		this.timer = this.clock.setTimeout(() => this.disable(), STARTUP_TIMEOUT_MS);
		this.worker.on("message", (matched: boolean | "ready") => {
			if (matched === "ready") {
				if (!this.worker) return;
				this.timer?.cancel();
				this.ready = true;
				this.pump();
				return;
			}
			if (!this.worker || !this.active) return;
			this.timer?.cancel();
			const item = this.active;
			this.active = undefined;
			this.bytes -= item.bytes;
			item.done(matched);
			this.pump();
		});
		this.worker.on("error", () => this.disable());
	}

	test(text: string, done: (matched: boolean) => void): void {
		if (!this.worker) {
			done(true);
			return;
		}
		const bytes = Buffer.byteLength(text) + 64;
		if (this.bytes + bytes > MATCH_QUEUE_BYTES) {
			this.disable();
			done(true);
			return;
		}
		this.bytes += bytes;
		this.queue.push({ text, bytes, done });
		this.pump();
	}

	async drain(): Promise<void> {
		if (this.active || this.queue.length) {
			const deadline = this.clock.setTimeout(() => this.disable(), STARTUP_TIMEOUT_MS);
			try {
				await new Promise<void>((resolve) => this.drained.push(resolve));
			} finally {
				deadline.cancel();
			}
		}
	}

	async close(): Promise<void> {
		this.disable();
		await this.termination;
	}

	private pump(): void {
		if (!this.worker || !this.ready || this.active) return;
		this.active = this.queue.shift();
		if (!this.active) {
			for (const resolve of this.drained.splice(0)) resolve();
			return;
		}
		this.timer = this.clock.setTimeout(() => this.disable(), MATCH_TIMEOUT_MS);
		this.worker.send(this.active.text);
	}

	private disable(): void {
		this.timer?.cancel();
		const worker = this.worker;
		this.worker = undefined;
		if (worker) worker.kill("SIGKILL");
		const pending = this.active ? [this.active, ...this.queue] : [...this.queue];
		this.active = undefined;
		this.queue.length = 0;
		this.bytes = 0;
		for (const item of pending) item.done(true);
		for (const resolve of this.drained.splice(0)) resolve();
	}
}
