/** Bounded line buffer with monotonically increasing line numbers, so `since` cursors survive eviction. */

export const RING_CAPACITY = 2000;

export interface NumberedLine {
	/** 1-based, never reused, keeps counting after old lines are evicted. */
	n: number;
	text: string;
}

export interface RingRead {
	lines: NumberedLine[];
	/** Lines after `since` that were already evicted and so cannot be returned. */
	missed: number;
}

export class RingBuffer {
	private readonly slots: (string | undefined)[];
	private total = 0;

	constructor(readonly capacity = RING_CAPACITY) {
		if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("capacity must be a positive integer");
		this.slots = new Array<string | undefined>(capacity);
	}

	/** Append one line and return it with its number. */
	push(text: string): NumberedLine {
		this.total += 1;
		this.slots[(this.total - 1) % this.capacity] = text;
		return { n: this.total, text };
	}

	/** Number of the newest line, 0 when nothing was ever pushed. */
	get lastLine(): number {
		return this.total;
	}

	/** Text of the newest line, undefined when nothing was ever pushed. */
	get lastText(): string | undefined {
		return this.total === 0 ? undefined : this.slots[(this.total - 1) % this.capacity];
	}

	/** Number of the oldest retained line, `lastLine + 1` when empty. */
	get firstLine(): number {
		return Math.max(1, this.total - this.capacity + 1);
	}

	/** Lines numbered greater than `since` (default: everything retained). */
	read(since = 0): RingRead {
		const after = Math.max(0, Math.floor(Number.isFinite(since) ? since : 0));
		const first = Math.max(this.firstLine, after + 1);
		const lines: NumberedLine[] = [];
		for (let n = first; n <= this.total; n++) lines.push({ n, text: this.slots[(n - 1) % this.capacity] ?? "" });
		const missed = Math.max(0, this.firstLine - (after + 1));
		return { lines, missed };
	}
}
