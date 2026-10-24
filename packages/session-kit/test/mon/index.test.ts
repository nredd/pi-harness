import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMon } from "../../src/mon/index.ts";
import { snapshot } from "./fixtures.ts";

// biome-ignore lint/suspicious/noExplicitAny: deliberately small Pi command/lifecycle test host
type Any = any;

function setup(mode = "tui") {
	const events = new Map<string, () => void>();
	let handler: Any;
	let view: Any;
	const dispose = vi.fn();
	const sample = vi.fn(async () => snapshot());
	const createSource = vi.fn(() => ({ sample, dispose }));
	const notify = vi.fn();
	const fg = vi.fn((_c: string, s: string) => s);
	const messages = vi.fn();
	registerMon(
		{
			on: (event: string, callback: () => void) => events.set(event, callback),
			registerCommand: (_name: string, command: Any) => {
				handler = command.handler;
			},
			sendMessage: messages,
		} as Any,
		{ createSource },
	);
	const custom = vi.fn(
		(factory: Any) =>
			new Promise<void>((resolve) => {
				view = factory(
					{ terminal: { rows: 20 }, requestRender: vi.fn() },
					{ fg, bg: (_c: string, s: string) => s, bold: (s: string) => s },
					{},
					resolve,
				);
			}),
	);
	return {
		events,
		createSource,
		sample,
		dispose,
		notify,
		custom,
		messages,
		fg,
		render: () => view.render(80),
		run: () => handler("", { mode, ui: { custom, notify } }),
		input: (s: string) => view.handleInput(s),
	};
}

afterEach(() => vi.useRealTimers());

describe("mon interaction lifecycle", () => {
	it.each(["rpc", "json", "print"])("does not sample in %s mode", async (mode) => {
		const h = setup(mode);
		await h.run();
		expect(h.createSource).not.toHaveBeenCalled();
		expect(h.custom).not.toHaveBeenCalled();
		expect(h.messages).not.toHaveBeenCalled();
	});

	it.each(["q", "\u001b", "session_shutdown", "session_start"])("releases timers and sampler on %s", async (action) => {
		vi.useFakeTimers();
		const h = setup();
		expect(h.createSource).not.toHaveBeenCalled();
		const run = h.run();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.sample).toHaveBeenCalledOnce();
		if (action.startsWith("session_")) h.events.get(action)?.();
		else h.input(action);
		await run;
		expect(h.dispose).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
		expect(h.messages).not.toHaveBeenCalled();
	});

	it("closes and reaps probes when the renderer throws", async () => {
		vi.useFakeTimers();
		const h = setup();
		const run = h.run();
		await vi.advanceTimersByTimeAsync(0);
		h.fg.mockImplementation(() => {
			throw new Error("theme unavailable");
		});
		expect(h.render).toThrow("theme unavailable");
		await run;
		expect(h.dispose).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("invalidates a deferred UI factory before it can create a source", async () => {
		const h = setup();
		let admit!: () => void;
		const admission = new Promise<void>((resolve) => {
			admit = resolve;
		});
		const original = h.custom.getMockImplementation();
		h.custom.mockImplementationOnce(async (factory) => {
			await admission;
			return original?.(factory);
		});
		const run = h.run();
		await vi.waitFor(() => expect(h.custom).toHaveBeenCalledOnce());
		const shutdown = h.events.get("session_shutdown")?.();
		admit();
		await Promise.all([run, shutdown]);
		expect(h.createSource).not.toHaveBeenCalled();
	});

	it("serializes concurrent replacements through deferred source disposal", async () => {
		vi.useFakeTimers();
		const h = setup();
		let release!: () => void;
		h.dispose.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const first = h.run();
		await vi.advanceTimersByTimeAsync(0);
		const second = h.run();
		const third = h.run();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.createSource).toHaveBeenCalledTimes(1);
		release();
		await vi.advanceTimersByTimeAsync(0);
		await Promise.all([first, second]);
		expect(h.createSource).toHaveBeenCalledTimes(3);
		expect(h.dispose).toHaveBeenCalledTimes(2);
		h.input("q");
		await third;
		expect(h.dispose).toHaveBeenCalledTimes(3);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(["session_shutdown", "session_start"])("invalidates queued openers on %s during disposal", async (event) => {
		vi.useFakeTimers();
		const h = setup();
		let release!: () => void;
		h.dispose.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const first = h.run();
		await vi.advanceTimersByTimeAsync(0);
		const second = h.run();
		const third = h.run();
		await vi.advanceTimersByTimeAsync(0);
		const shutdown = h.events.get(event)?.();
		release();
		await Promise.all([first, second, third, shutdown]);
		expect(h.createSource).toHaveBeenCalledOnce();
		expect(h.dispose).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("disposes the previous interaction before reopening", async () => {
		vi.useFakeTimers();
		const h = setup();
		const first = h.run();
		const second = h.run();
		await first;
		expect(h.dispose).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(0);
		h.input("q");
		await second;
		expect(h.dispose).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});
});
