/** Collects a bounded batch for a fixed window after the first item. */

export interface CoalescedBatch<T> {
	items: T[];
	dropped: number;
	droppedMatched: boolean;
}

export class Coalescer<T> {
	private items: T[] = [];
	private bytes = 0;
	private dropped = 0;
	private droppedMatched = false;
	private timer: NodeJS.Timeout | undefined;

	constructor(
		private readonly windowMs: number,
		private readonly onFlush: (batch: CoalescedBatch<T>) => void,
		private readonly options: {
			maxItems?: number;
			maxBytes?: number;
			sizeOf?: (item: T) => number;
			matched?: (item: T) => boolean;
		} = {},
	) {}

	add(item: T): void {
		const size = this.options.sizeOf?.(item) ?? 1;
		const maxItems = this.options.maxItems ?? 200;
		const maxBytes = this.options.maxBytes ?? 64 * 1024;
		if (this.items.length >= maxItems || this.bytes + size > maxBytes) {
			this.dropped++;
			this.droppedMatched ||= this.options.matched?.(item) ?? false;
		} else {
			this.items.push(item);
			this.bytes += size;
		}
		if (this.timer) return;
		this.timer = setTimeout(() => this.flush(), this.windowMs);
		this.timer.unref();
	}

	flush(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		const batch = this.takeBatch();
		if (batch.items.length === 0 && batch.dropped === 0) return;
		this.onFlush(batch);
	}

	/** Take what is pending without calling `onFlush`. */
	take(): CoalescedBatch<T> {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		return this.takeBatch();
	}

	cancel(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.items = [];
		this.bytes = 0;
		this.dropped = 0;
		this.droppedMatched = false;
	}

	private takeBatch(): CoalescedBatch<T> {
		const batch = { items: this.items, dropped: this.dropped, droppedMatched: this.droppedMatched };
		this.items = [];
		this.bytes = 0;
		this.dropped = 0;
		this.droppedMatched = false;
		return batch;
	}
}
