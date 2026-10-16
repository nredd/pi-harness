/**
 * Which background subagents a goal must wait for, from the `subagents:*` events pi-subagents
 * emits on `pi.events` (see `~/code/pi-subagents/src/index.ts`).
 *
 * - `running`: between `created`/`started` and `completed`/`failed`.
 * - `unannounced`: a background agent finished but its completion notice has not been delivered.
 *   pi-subagents queues notices in an outbox and flushes them at `agent_end`, i.e. AFTER the
 *   settle boundary, so a nudge sent at settle would run a turn in front of the notice.
 *
 * A nudge is skipped while either set is non-empty, so the notice (a `followUp` that triggers a
 * turn) is delivered first and the goal nudges at the following settle.
 */

export interface EventBus {
	on(event: string, handler: (data: unknown) => void): () => void;
}

function idOf(data: unknown): string | undefined {
	const id = (data as { id?: unknown } | null)?.id;
	return typeof id === "string" ? id : undefined;
}

export class SubagentTracker {
	private readonly running = new Set<string>();
	private readonly unannounced = new Set<string>();
	private readonly background = new Set<string>();
	private detach: (() => void)[] = [];

	/** Called when the last running agent finishes, e.g. to re-arm the wake timer. */
	constructor(private readonly onIdle: () => void = () => {}) {}

	attach(events: EventBus): void {
		this.detach.push(
			events.on("subagents:created", (data) => {
				const id = idOf(data);
				if (!id) return;
				this.running.add(id);
				if ((data as { isBackground?: unknown }).isBackground === true) this.background.add(id);
			}),
			events.on("subagents:started", (data) => {
				const id = idOf(data);
				if (id) this.running.add(id);
			}),
			events.on("subagents:completed", (data) => this.finish(idOf(data))),
			events.on("subagents:failed", (data) => this.finish(idOf(data))),
		);
	}

	private finish(id: string | undefined): void {
		if (!id) return;
		this.running.delete(id);
		if (this.background.delete(id)) this.unannounced.add(id);
		if (this.running.size === 0) this.onIdle();
	}

	/** The notices were delivered (or the results fetched): nothing is waiting to be announced. */
	announced(): void {
		this.unannounced.clear();
	}

	busy(): number {
		return this.running.size + this.unannounced.size;
	}

	runningCount(): number {
		return this.running.size;
	}

	/** Drop every subscription and id (session shutdown). */
	dispose(): void {
		for (const off of this.detach) off();
		this.detach = [];
		this.running.clear();
		this.unannounced.clear();
		this.background.clear();
	}
}
