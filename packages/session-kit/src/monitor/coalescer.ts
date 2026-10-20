/** Collects a bounded batch for a fixed window after the first item. */
import { type Clock, realClock, type TimerHandle } from "../clock.ts";

export interface CoalescedBatch<T> {
	items: T[];
	dropped: number;
	droppedMatched: boolean;
	/** First and newest dropped matches, retained independently of passive batch storage. */
	droppedMatches: T[];
}

export class Coalescer<T> {
	private items: T[] = [];
	private bytes = 0;
	private dropped = 0;
	private droppedMatched = false;
	private droppedMatches: T[] = [];
	private timer: TimerHandle | undefined;

	constructor(
		private readonly windowMs: number,
		private readonly onFlush: (batch: CoalescedBatch<T>) => void,
		private readonly options: {
			maxItems?: number;
			maxBytes?: number;
			sizeOf?: (item: T) => number;
			matched?: (item: T) => boolean;
		} = {},
		private readonly clock: Clock = realClock,
	) {}

	add(item: T): void {
		const size = this.options.sizeOf?.(item) ?? 1;
		const maxItems = this.options.maxItems ?? 200;
		const maxBytes = this.options.maxBytes ?? 64 * 1024;
		if (this.items.length >= maxItems || this.bytes + size > maxBytes) {
			this.dropped++;
			if (this.options.matched?.(item)) {
				this.droppedMatched = true;
				if (this.droppedMatches.length < 2) this.droppedMatches.push(item);
				else this.droppedMatches[1] = item;
			}
		} else {
			this.items.push(item);
			this.bytes += size;
		}
		if (this.timer) return;
		this.timer = this.clock.setTimeout(() => this.flush(), this.windowMs);
	}

	flush(): void {
		this.timer?.cancel();
		this.timer = undefined;
		const batch = this.takeBatch();
		if (batch.items.length === 0 && batch.dropped === 0) return;
		this.onFlush(batch);
	}

	/** Take what is pending without calling `onFlush`. */
	take(): CoalescedBatch<T> {
		this.timer?.cancel();
		this.timer = undefined;
		return this.takeBatch();
	}

	cancel(): void {
		this.timer?.cancel();
		this.timer = undefined;
		this.items = [];
		this.bytes = 0;
		this.dropped = 0;
		this.droppedMatched = false;
		this.droppedMatches = [];
	}

	private takeBatch(): CoalescedBatch<T> {
		const batch = {
			items: this.items,
			dropped: this.dropped,
			droppedMatched: this.droppedMatched,
			droppedMatches: this.droppedMatches,
		};
		this.items = [];
		this.bytes = 0;
		this.dropped = 0;
		this.droppedMatched = false;
		this.droppedMatches = [];
		return batch;
	}
}
