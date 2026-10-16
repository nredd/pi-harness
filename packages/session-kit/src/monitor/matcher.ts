/**
 * Isolate model-provided backtracking regexes from pi's event loop. One worker per matching monitor,
 * one line in flight, 100ms per test (excluding worker startup, which has a 1s deadline). Queued
 * text plus per-item overhead is capped at 256KiB; final draining is bounded to 1s. On timeout, overflow or worker failure, disable matching for this monitor
 * and conservatively mark pending/future lines matched: output still wakes rather than losing alerts.
 * Normal tests retain JS RegExp semantics and line ordering. close() interrupts work and awaits worker
 * termination; drain() waits for queued callbacks before the monitor's final output is delivered.
 */
import { Worker } from "node:worker_threads";

export const MATCH_TIMEOUT_MS = 100;
export const MATCH_QUEUE_BYTES = 256 * 1024;
const STARTUP_TIMEOUT_MS = 1000;
const SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const regex = new RegExp(workerData);
parentPort.on('message', text => parentPort.postMessage(regex.test(text)));
`;

interface Pending {
	text: string;
	bytes: number;
	done: (matched: boolean) => void;
}

export class BoundedMatcher {
	private worker: Worker | undefined;
	private ready = false;
	private active: Pending | undefined;
	private readonly queue: Pending[] = [];
	private bytes = 0;
	private timer: NodeJS.Timeout | undefined;
	private readonly drained: (() => void)[] = [];
	private termination: Promise<unknown> = Promise.resolve();

	constructor(source: string) {
		this.worker = new Worker(SOURCE, { eval: true, workerData: source });
		this.timer = setTimeout(() => this.disable(), STARTUP_TIMEOUT_MS);
		this.worker.once("online", () => {
			if (!this.worker) return;
			clearTimeout(this.timer);
			this.ready = true;
			this.pump();
		});
		this.worker.on("message", (matched: boolean) => {
			if (!this.worker || !this.active) return;
			clearTimeout(this.timer);
			const item = this.active;
			this.active = undefined;
			this.bytes -= item.bytes;
			item.done(matched);
			this.pump();
		});
		this.worker.on("error", () => this.disable());
		this.worker.on("exit", () => this.disable());
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
			const deadline = setTimeout(() => this.disable(), STARTUP_TIMEOUT_MS);
			try {
				await new Promise<void>((resolve) => this.drained.push(resolve));
			} finally {
				clearTimeout(deadline);
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
		this.timer = setTimeout(() => this.disable(), MATCH_TIMEOUT_MS);
		this.worker.postMessage(this.active.text);
	}

	private disable(): void {
		clearTimeout(this.timer);
		const worker = this.worker;
		this.worker = undefined;
		if (worker) this.termination = worker.terminate();
		const pending = this.active ? [this.active, ...this.queue] : [...this.queue];
		this.active = undefined;
		this.queue.length = 0;
		this.bytes = 0;
		for (const item of pending) item.done(true);
		for (const resolve of this.drained.splice(0)) resolve();
	}
}
