/** Deterministic timer queue shared by every suite that drives production timers. */

/** Cancelable handle, structurally identical to each production `TimerHandle`. */
export interface TimerHandle {
	cancel(): void;
}

/** Default start for callers that do not care about the date. */
export const DEFAULT_START = Date.parse("2020-01-01T00:00:00.000Z");

interface Timer {
	at: number;
	interval?: number;
	callback: () => void;
}

/**
 * Advancing runs production callbacks in deadline/insertion order, including rearming and
 * cancellation, never wall-clock sleeps. Satisfies the production `Clock` interfaces of
 * session-kit, subagents and preset structurally.
 */
export class FakeClock {
	/** Ids of every timer run, in execution order (one entry per interval firing). */
	readonly fired: number[] = [];
	/** Delay of every one-shot timer ever scheduled, so a test can tell which sleep was armed. */
	readonly timeoutDelays: number[] = [];
	private time: number;
	private nextId = 0;
	private readonly timers = new Map<number, Timer>();

	constructor(start = DEFAULT_START) {
		this.time = start;
	}

	/** Arrow property so `{ now: clock.now }` works unbound. */
	readonly now = (): number => this.time;

	setTimeout(callback: () => void, ms: number): TimerHandle {
		this.timeoutDelays.push(ms);
		return this.schedule(callback, ms);
	}

	setInterval(callback: () => void, ms: number): TimerHandle {
		return this.schedule(callback, ms, ms);
	}

	/** Live timers, to prove stop/shutdown and one-shot expiry leave no scheduling behind. */
	get pending(): number {
		return this.timers.size;
	}

	/** Run every callback due within the next `ms`, then land exactly on the new time. */
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
