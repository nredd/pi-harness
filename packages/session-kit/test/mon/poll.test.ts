import { afterEach, describe, expect, it, vi } from "vitest";
import { MonPoll, type MonSource } from "../../src/mon/poll.ts";
import { snapshot } from "./fixtures.ts";

afterEach(() => {
	vi.useRealTimers();
});

describe("mon polling ownership", () => {
	it("does no work before start and has exactly one in-flight probe without catchup", async () => {
		vi.useFakeTimers();
		let resolve!: (value: ReturnType<typeof snapshot>) => void;
		const source: MonSource = {
			sample: vi.fn(
				() =>
					new Promise<ReturnType<typeof snapshot>>((r) => {
						resolve = r;
					}),
			),
			dispose: vi.fn(),
		};
		const update = vi.fn();
		const poll = new MonPoll(source, update);
		expect(source.sample).not.toHaveBeenCalled();
		poll.start();
		poll.start();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(source.sample).toHaveBeenCalledTimes(1);
		resolve(snapshot());
		await vi.advanceTimersByTimeAsync(0);
		expect(update).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1999);
		expect(source.sample).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(source.sample).toHaveBeenCalledTimes(2);
		await poll.dispose();
		await poll.dispose();
		expect(source.dispose).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
		resolve(snapshot());
		await vi.advanceTimersByTimeAsync(0);
		expect(update).toHaveBeenCalledOnce();
	});

	it("aborts in-flight work on disposal and ignores late replies", async () => {
		vi.useFakeTimers();
		let signal: AbortSignal | undefined;
		let resolve!: (value: ReturnType<typeof snapshot>) => void;
		const source: MonSource = {
			sample: vi.fn((s) => {
				signal = s;
				return new Promise<ReturnType<typeof snapshot>>((r) => {
					resolve = r;
				});
			}),
			dispose: vi.fn(),
		};
		const update = vi.fn();
		const poll = new MonPoll(source, update);
		poll.start();
		poll.dispose();
		expect(signal?.aborted).toBe(true);
		resolve(snapshot());
		await vi.advanceTimersByTimeAsync(10_000);
		expect(update).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("awaits asynchronous probe disposal once and cleans up after renderer errors", async () => {
		vi.useFakeTimers();
		let finish!: () => void;
		const source: MonSource = {
			sample: vi.fn(async () => snapshot()),
			dispose: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						finish = resolve;
					}),
			),
		};
		const poll = new MonPoll(source, () => {
			throw new Error("renderer failed");
		});
		poll.start();
		await vi.advanceTimersByTimeAsync(0);
		const cleanup = poll.dispose();
		expect(poll.dispose()).toBe(cleanup);
		expect(source.dispose).toHaveBeenCalledOnce();
		finish();
		await cleanup;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("retains last values as stale on failure, disposes and stops timers", async () => {
		vi.useFakeTimers();
		const sample = vi.fn().mockResolvedValueOnce(snapshot()).mockRejectedValueOnce(new Error("private diagnostic"));
		const source: MonSource = { sample, dispose: vi.fn() };
		const update = vi.fn();
		const poll = new MonPoll(source, update);
		poll.start();
		await vi.advanceTimersByTimeAsync(2000);
		expect(update.mock.calls[1]?.[0]).toMatchObject({ status: "stale", cpuPercent: 36.2 });
		expect(JSON.stringify(update.mock.calls)).not.toContain("private diagnostic");
		expect(source.dispose).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});
});
