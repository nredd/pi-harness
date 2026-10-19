/** Timers used by session scheduling. Handles own cancellation, not Node-specific timer methods. */
export interface TimerHandle {
	cancel(): void;
}

/** Injectable scheduling boundary; production timers are unreferenced so they cannot keep Pi alive. */
export interface Clock {
	now(): number;
	setTimeout(callback: () => void, ms: number): TimerHandle;
	setInterval(callback: () => void, ms: number): TimerHandle;
}

export const realClock: Clock = {
	now: () => Date.now(),
	setTimeout(callback, ms) {
		const timer = setTimeout(callback, ms);
		timer.unref();
		return { cancel: () => clearTimeout(timer) };
	},
	setInterval(callback, ms) {
		const timer = setInterval(callback, ms);
		timer.unref();
		return { cancel: () => clearInterval(timer) };
	},
};
