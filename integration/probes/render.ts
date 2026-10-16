/**
 * In-process render probe for the bench tier; loaded with `-e`, never installed.
 *
 * `/harness-probe [frames]` grabs the live TUI through a throwaway widget factory, then times
 * `frames` full frames: each one invalidates every component (no render caches) and calls
 * `renderNow(true)`, the same forced path a resize takes, including the terminal write. Then it
 * times `frames` steady frames: `renderNow()` with no invalidate, the path a keystroke or a
 * spinner tick takes, where every settled component should answer from its cache. After a GC
 * (when `--expose-gc` is on) it reads `heapUsed`. One JSON line is appended to
 * `HARNESS_PROBE_OUT`:
 *   { "frames_ms": [..], "steady_frames_ms": [..], "heap_used": bytes, "gc": bool, "width": n, "height": n }
 */

import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

const WIDGET_KEY = "harness-probe";
const DEFAULT_FRAMES = 10;
const WARMUP_FRAMES = 2;

function captureTui(setWidget: (key: string, content: unknown) => void): TUI | undefined {
	let captured: TUI | undefined;
	setWidget(WIDGET_KEY, (tui: TUI) => {
		captured = tui;
		return { render: () => [], invalidate: () => {} };
	});
	setWidget(WIDGET_KEY, undefined);
	return captured;
}

function timeFrame(tui: TUI): number {
	tui.invalidate();
	const started = performance.now();
	tui.renderNow(true);
	return performance.now() - started;
}

function timeSteadyFrame(tui: TUI): number {
	const started = performance.now();
	tui.renderNow();
	return performance.now() - started;
}

export default function harnessProbe(pi: ExtensionAPI): void {
	pi.registerCommand("harness-probe", {
		description: "Harness: time full frames and read the heap",
		handler: async (args, ctx) => {
			const out = process.env.HARNESS_PROBE_OUT;
			if (!out) throw new Error("HARNESS_PROBE_OUT is not set");
			const frames = Number.parseInt(args.trim(), 10) || DEFAULT_FRAMES;
			const tui = captureTui(ctx.ui.setWidget as (key: string, content: unknown) => void);
			if (!tui) throw new Error("The widget factory never ran; no TUI to probe");
			for (let i = 0; i < WARMUP_FRAMES; i++) timeFrame(tui);
			const framesMs = Array.from({ length: frames }, () => timeFrame(tui));
			for (let i = 0; i < WARMUP_FRAMES; i++) timeSteadyFrame(tui);
			const steadyFramesMs = Array.from({ length: frames }, () => timeSteadyFrame(tui));
			const gc = (globalThis as { gc?: () => void }).gc;
			gc?.();
			const record = {
				frames_ms: framesMs,
				steady_frames_ms: steadyFramesMs,
				heap_used: process.memoryUsage().heapUsed,
				gc: gc !== undefined,
				width: tui.terminal.columns,
				height: tui.terminal.rows,
			};
			appendFileSync(out, `${JSON.stringify(record)}\n`);
		},
	});
}
