import { expect, test } from "vitest";
import { DEFAULT_START, FakeClock } from "../src/clock.ts";

test("starts at the default or an injected time and advances without timers", () => {
	expect(new FakeClock().now()).toBe(DEFAULT_START);
	const clock = new FakeClock(5);
	clock.advance(10);
	expect(clock.now()).toBe(15);
});

test("now is bound, so it can be handed over detached", () => {
	const { now } = new FakeClock(7);
	expect(now()).toBe(7);
});

test("one-shot timers fire once, in deadline then insertion order, at their own time", () => {
	const clock = new FakeClock(0);
	const log: string[] = [];
	clock.setTimeout(() => log.push(`late@${clock.now()}`), 20);
	clock.setTimeout(() => log.push(`first@${clock.now()}`), 10);
	clock.setTimeout(() => log.push(`tie@${clock.now()}`), 10);
	expect(clock.pending).toBe(3);
	clock.advance(15);
	expect(log).toEqual(["first@10", "tie@10"]);
	expect(clock.now()).toBe(15);
	clock.advance(100);
	expect(log).toEqual(["first@10", "tie@10", "late@20"]);
	expect(clock.pending).toBe(0);
	expect(clock.timeoutDelays).toEqual([20, 10, 10]);
});

test("intervals rearm and record every firing; cancel stops them", () => {
	const clock = new FakeClock(0);
	let ticks = 0;
	const handle = clock.setInterval(() => {
		ticks++;
	}, 10);
	clock.setTimeout(() => {}, 5);
	clock.advance(35);
	expect(ticks).toBe(3);
	expect(clock.fired).toEqual([2, 1, 1, 1]);
	expect(clock.pending).toBe(1);
	handle.cancel();
	expect(clock.pending).toBe(0);
	clock.advance(100);
	expect(ticks).toBe(3);
	expect(clock.timeoutDelays).toEqual([5]);
});

test("a callback may cancel or schedule timers while the queue is draining", () => {
	const clock = new FakeClock(0);
	const log: string[] = [];
	const doomed = clock.setTimeout(() => log.push("doomed"), 10);
	clock.setTimeout(() => {
		doomed.cancel();
		clock.setTimeout(() => log.push("chained"), 5);
	}, 5);
	clock.advance(20);
	expect(log).toEqual(["chained"]);
});
