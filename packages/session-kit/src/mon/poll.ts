/** Single-flight, completion-paced sampling. No polling exists outside an open interaction. */
import { type Clock, realClock, type TimerHandle } from "../clock.ts";
import type { MonSnapshot } from "./model.ts";

/** Presentation boundary; the production adapter must delegate to the shared sampler. */
export interface MonSource {
	sample(signal: AbortSignal): Promise<MonSnapshot>;
	dispose(): void | Promise<void>;
}

/** Errors retain the last data as explicitly stale and stop probes until the view is reopened. */
export class MonPoll {
	private timer: TimerHandle | undefined;
	private readonly abort = new AbortController();
	private disposed = false;
	private started = false;
	private last: MonSnapshot | undefined;
	private cleanup: Promise<void> | undefined;

	constructor(
		private readonly source: MonSource,
		private readonly update: (snapshot: MonSnapshot) => void,
		private readonly clock: Clock = realClock,
		private readonly intervalMs = 2000,
	) {}

	start(): void {
		if (this.started || this.disposed) return;
		this.started = true;
		void this.poll().catch(() => {});
	}

	private async poll(): Promise<void> {
		try {
			const snapshot = await this.source.sample(this.abort.signal);
			if (this.disposed) return;
			this.last = snapshot;
			this.update(snapshot);
			if (!this.disposed)
				this.timer = this.clock.setTimeout(() => {
					void this.poll().catch(() => {});
				}, this.intervalMs);
		} catch {
			if (this.disposed) return;
			try {
				this.update({
					cpuPercent: null,
					logicalCpus: 0,
					memoryUsedBytes: null,
					memoryTotalBytes: null,
					load: [],
					processes: [],
					capturedAt: this.clock.now(),
					...this.last,
					status: "stale",
					notice: "Sampling stopped. Close and reopen to retry.",
				});
			} catch {
				// A failed renderer must not leave collection running or reject an unobserved task.
			} finally {
				await this.dispose();
			}
		}
	}

	/** Await this at the command boundary so asynchronous probes are reaped before returning. */
	dispose(): Promise<void> {
		if (this.cleanup) return this.cleanup;
		this.disposed = true;
		this.timer?.cancel();
		this.timer = undefined;
		this.abort.abort();
		this.cleanup = Promise.resolve().then(() => this.source.dispose());
		// Timer callbacks cannot surface cleanup failures; the command's finally awaits the same promise.
		void this.cleanup.catch(() => {});
		return this.cleanup;
	}
}
