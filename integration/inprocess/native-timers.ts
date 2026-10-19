/** Freeze native deadlines without interfering with the stack's injected FakeClock. */
export interface FrozenTimer {
	kind: "timeout" | "interval";
	delay: number;
	origin: string;
	cleared: boolean;
}

let nextId = -1;

/** Node and Bun's Timeout surface, with no native resource and no way to arm one. */
class InertTimer {
	readonly id = nextId--;
	private referenced = true;

	constructor(readonly record: FrozenTimer) {}

	ref(): this {
		this.referenced = true;
		return this;
	}

	unref(): this {
		this.referenced = false;
		return this;
	}

	hasRef(): boolean {
		return this.referenced;
	}

	refresh(): this {
		return this;
	}

	close(): this {
		this.record.cleared = true;
		return this;
	}

	[Symbol.toPrimitive](): number {
		return this.id;
	}

	[Symbol.dispose](): void {
		this.close();
	}
}

/**
 * Install before loading extensions; restore in finally after their shutdown handlers.
 * Positive delays never fire, even after refresh(). Zero/omitted delays remain real
 * macrotasks (notably core retry with baseDelayMs: 0). Records are diagnostics, not an
 * allowlist: passing with every positive deadline frozen is the inertness proof.
 */
export function freezeNativeTimers(): { records: FrozenTimer[]; restore(): void } {
	const real = {
		setTimeout: globalThis.setTimeout,
		setInterval: globalThis.setInterval,
		clearTimeout: globalThis.clearTimeout,
		clearInterval: globalThis.clearInterval,
	};
	const records: FrozenTimer[] = [];
	const handles = new Map<number, InertTimer>();
	function inert(kind: FrozenTimer["kind"], delay: number): ReturnType<typeof setTimeout> {
		const origin =
			new Error().stack?.split("\n").find((line) => line.includes("at ") && !line.includes("native-timers.ts")) ??
			"unknown origin";
		const record = { kind, delay, origin: origin.trim(), cleared: false };
		const handle = new InertTimer(record);
		records.push(record);
		handles.set(handle.id, handle);
		return handle as unknown as ReturnType<typeof setTimeout>;
	}
	function clear(handle: unknown): boolean {
		const timer = handle instanceof InertTimer ? handle : typeof handle === "number" ? handles.get(handle) : undefined;
		if (!timer) return false;
		timer.close();
		return true;
	}
	globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) =>
		Number(args[1]) > 0 ? inert("timeout", Number(args[1])) : real.setTimeout(...args)) as typeof setTimeout;
	globalThis.setInterval = ((...args: Parameters<typeof setInterval>) =>
		Number(args[1]) > 0 ? inert("interval", Number(args[1])) : real.setInterval(...args)) as typeof setInterval;
	globalThis.clearTimeout = (handle) => {
		if (!clear(handle)) real.clearTimeout(handle);
	};
	globalThis.clearInterval = (handle) => {
		if (!clear(handle)) real.clearInterval(handle);
	};
	return {
		records,
		restore() {
			Object.assign(globalThis, real);
		},
	};
}
