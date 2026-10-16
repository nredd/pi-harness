/**
 * Latency probe: event-loop lag, terminal output volume, input-to-paint, fs latency.
 *
 * Loaded with `-e` (harness or a live session), never installed. Starts on `session_start`.
 * Env:
 *   PI_LATENCY_PROBE   JSONL path; a `summary` line is appended every `PI_LATENCY_INTERVAL_MS`
 *                      (default 5000) and on exit. `HARNESS_PROBE_OUT` is the fallback.
 *   PI_LATENCY_STALL_BLOCK_MS  self-test: block the loop this long once, 1.5 s after start
 *
 * Each line:
 *   { "kind": "summary", "t": epoch_ms, "pid": n, "window_s": s,
 *     "loop_lag_ms": { p50, p95, p99, max }, "stalls": [{ "at": epoch_ms, "ms": n }],
 *     "write": { "bytes": n, "calls": n, "bytes_per_s": n, "max_block_ms": n, "total_block_ms": n },
 *     "input_to_paint_ms": [..], "fs": { "type": s, "stat_ms": n, "fsync_ms": n }, ... }
 * The first line has kind `start` and carries platform, node, cpus and WSL tagging.
 *
 * Loop lag is drift of a 10 ms timer, so it measures how late the event loop ran a due callback.
 * `write.max_block_ms` is time spent inside `terminal.write`, i.e. stdout backpressure.
 * Input-to-paint is stdin data -> the next `terminal.write`; it excludes terminal-side paint.
 */

import { appendFileSync, closeSync, fsyncSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { cpus, platform } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

const WIDGET_KEY = "latency-probe";
const TICK_MS = 10;
const STALL_MS = 50;
const DEFAULT_INTERVAL_MS = 5000;
const MAX_STALLS = 50;
const MAX_INPUT_SAMPLES = 200;

function percentile(sorted: number[], q: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
	return sorted[Math.max(0, index)]!;
}

function isWsl(): boolean {
	try {
		return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf8"));
	} catch {
		return false;
	}
}

function fsType(dir: string): string {
	try {
		const mounts = readFileSync("/proc/self/mountinfo", "utf8").split("\n");
		let best = { mount: "", type: "unknown" };
		for (const line of mounts) {
			const [pre, post] = line.split(" - ");
			const mount = pre?.split(" ")[4];
			const type = post?.split(" ")[0];
			if (mount && type && dir.startsWith(mount) && mount.length >= best.mount.length) best = { mount, type };
		}
		return best.type;
	} catch {
		return platform();
	}
}

function fsLatency(dir: string): { type: string; stat_ms: number; fsync_ms: number } {
	const file = join(dir, `.latency-probe-${process.pid}`);
	let statMs = -1;
	let fsyncMs = -1;
	try {
		let started = performance.now();
		statSync(dir);
		statMs = performance.now() - started;
		const fd = openSync(file, "w");
		writeSync(fd, "x");
		started = performance.now();
		fsyncSync(fd);
		fsyncMs = performance.now() - started;
		closeSync(fd);
		unlinkSync(file);
	} catch {
		// Read-only agent dir: leave -1.
	}
	return { type: fsType(dir), stat_ms: statMs, fsync_ms: fsyncMs };
}

function captureTui(setWidget: (key: string, content: unknown) => void): TUI | undefined {
	let captured: TUI | undefined;
	setWidget(WIDGET_KEY, (tui: TUI) => {
		captured = tui;
		return { render: () => [], invalidate: () => {} };
	});
	setWidget(WIDGET_KEY, undefined);
	return captured;
}

export default function latencyProbe(pi: ExtensionAPI): void {
	const out = process.env.PI_LATENCY_PROBE ?? process.env.HARNESS_PROBE_OUT;
	if (!out) return;
	const emit = (record: Record<string, unknown>) => appendFileSync(out, `${JSON.stringify(record)}\n`);
	let started = false;

	pi.on("session_start", async (_event, ctx) => {
		if (started) return;
		started = true;
		const tui = captureTui(ctx.ui.setWidget as (key: string, content: unknown) => void);
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? ".", ".pi", "agent");
		emit({
			kind: "start",
			t: Date.now(),
			pid: process.pid,
			platform: platform(),
			wsl: isWsl(),
			node: process.version,
			cpus: cpus().length,
			tui: tui !== undefined,
			fs: fsLatency(agentDir),
		});

		let lags: number[] = [];
		let stalls: { at: number; ms: number }[] = [];
		let write = { bytes: 0, calls: 0, max_block_ms: 0, total_block_ms: 0 };
		let inputs: number[] = [];
		let pendingInput: number | undefined;
		let windowStart = performance.now();

		if (tui) {
			const terminal = tui.terminal;
			const original = terminal.write.bind(terminal);
			terminal.write = (data: string) => {
				const now = performance.now();
				if (pendingInput !== undefined && inputs.length < MAX_INPUT_SAMPLES) inputs.push(now - pendingInput);
				pendingInput = undefined;
				original(data);
				const block = performance.now() - now;
				write.bytes += Buffer.byteLength(data);
				write.calls += 1;
				write.total_block_ms += block;
				write.max_block_ms = Math.max(write.max_block_ms, block);
			};
		}
		process.stdin.prependListener("data", () => {
			pendingInput ??= performance.now();
		});

		let expected = performance.now() + TICK_MS;
		const tick = setInterval(() => {
			const now = performance.now();
			const lag = Math.max(0, now - expected);
			lags.push(lag);
			if (lag >= STALL_MS && stalls.length < MAX_STALLS) stalls.push({ at: Date.now(), ms: lag });
			expected = now + TICK_MS;
		}, TICK_MS);
		tick.unref();

		const blockMs = Number.parseInt(process.env.PI_LATENCY_STALL_BLOCK_MS ?? "", 10);
		if (blockMs > 0) {
			setTimeout(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, blockMs), 1500).unref();
		}

		const flush = () => {
			const now = performance.now();
			const windowS = (now - windowStart) / 1000;
			const sorted = [...lags].sort((a, b) => a - b);
			emit({
				kind: "summary",
				t: Date.now(),
				pid: process.pid,
				window_s: windowS,
				loop_lag_ms: {
					p50: percentile(sorted, 0.5),
					p95: percentile(sorted, 0.95),
					p99: percentile(sorted, 0.99),
					max: sorted.at(-1) ?? 0,
				},
				stalls,
				write: { ...write, bytes_per_s: windowS > 0 ? write.bytes / windowS : 0 },
				input_to_paint_ms: inputs,
				fs: fsLatency(agentDir),
				rss_mb: process.memoryUsage().rss / 1024 / 1024,
			});
			lags = [];
			stalls = [];
			write = { bytes: 0, calls: 0, max_block_ms: 0, total_block_ms: 0 };
			inputs = [];
			windowStart = now;
		};
		const interval = Number.parseInt(process.env.PI_LATENCY_INTERVAL_MS ?? "", 10) || DEFAULT_INTERVAL_MS;
		setInterval(flush, interval).unref();
		process.on("exit", flush);
	});
}
