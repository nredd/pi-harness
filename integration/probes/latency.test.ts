import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, test, vi } from "vitest";
import latencyProbe from "./latency.ts";

// Only the probe's `/proc` reads are faked, so the Linux and non-Linux paths both run on every OS.
// Every other `node:fs` call, including the real agent-dir stat/fsync, goes to the real module.
const proc = vi.hoisted(() => ({ files: new Map<string, string>() }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const readFileSync = ((path: fs.PathOrFileDescriptor, options?: unknown) => {
		if (typeof path === "string" && path.startsWith("/proc/")) {
			const content = proc.files.get(path);
			if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
			return content;
		}
		return actual.readFileSync(path, options as never);
	}) as typeof actual.readFileSync;
	return { ...actual, readFileSync };
});

type Handler = (event: unknown, ctx: unknown) => Promise<void>;
type Record = { kind: string; [key: string]: unknown };

const ENV = [
	"PI_LATENCY_PROBE",
	"HARNESS_PROBE_OUT",
	"PI_LATENCY_INTERVAL_MS",
	"PI_LATENCY_STALL_BLOCK_MS",
	"PI_CODING_AGENT_DIR",
] as const;
const saved = new Map(ENV.map((name) => [name, process.env[name]]));
let root = "";
let exitListeners: ((...args: unknown[]) => void)[] = [];
let stdinData: (() => void) | undefined;
// Milliseconds the probe's `Atomics.wait` self-test "blocked" for: added to the fake clock's
// `performance.now()` without firing any timer, exactly what a blocked event loop looks like.
let stalled = 0;

beforeEach(() => {
	root = fs.mkdtempSync(join(tmpdir(), "latency-probe-"));
	for (const name of ENV) delete process.env[name];
	proc.files.clear();
	// Real stdin is never put into flowing mode; the probe's listener is captured instead.
	stdinData = undefined;
	vi.spyOn(process.stdin, "prependListener").mockImplementation((event, listener) => {
		assert.equal(event, "data");
		stdinData = listener as () => void;
		return process.stdin;
	});
	exitListeners = process.listeners("exit") as typeof exitListeners;
	// Every clock the probe reads is virtual: no real time passes and no reading depends on load.
	vi.useFakeTimers({
		toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date", "performance"],
	});
	stalled = 0;
	const fakeNow = performance.now.bind(performance);
	vi.spyOn(performance, "now").mockImplementation(() => fakeNow() + stalled);
	vi.spyOn(Atomics, "wait").mockImplementation((_array, _index, _value, timeout) => {
		stalled += timeout ?? 0;
		return "timed-out";
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const listener of process.listeners("exit")) {
		if (!exitListeners.includes(listener as never)) process.removeListener("exit", listener);
	}
	for (const [name, value] of saved) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	fs.rmSync(root, { recursive: true, force: true });
});

/** The exit flush the probe registered in this test, if any. */
function exitFlush(): (() => void) | undefined {
	const added = process.listeners("exit").filter((listener) => !exitListeners.includes(listener as never));
	assert.ok(added.length <= 1);
	return added[0] as (() => void) | undefined;
}

/** A terminal double whose writes are recorded. */
function fakeTui() {
	const written: string[] = [];
	return { written, tui: { terminal: { write: (data: string) => written.push(data) } } };
}

/** Register the probe and return its `session_start` hook (if it registered one). */
function register(): Map<string, Handler> {
	const handlers = new Map<string, Handler>();
	latencyProbe({ on: (name: string, handler: Handler) => handlers.set(name, handler) } as unknown as ExtensionAPI);
	return handlers;
}

/** A ctx whose widget factory either receives `tui` or is never called. */
function context(tui: unknown) {
	return {
		ui: {
			setWidget: (_key: string, content: unknown) => {
				if (typeof content !== "function" || tui === undefined) return;
				const component = content(tui);
				assert.deepEqual(component.render(80), []);
				component.invalidate();
			},
		},
	};
}

function records(path: string): Record[] {
	return fs
		.readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record);
}

test("does nothing without an output path", () => {
	assert.equal(register().size, 0);
});

test("on Linux it tags WSL, picks the longest matching mount and times input-to-paint and writes", async () => {
	const out = join(root, "harness.jsonl");
	const agentDir = join(root, "agent");
	fs.mkdirSync(agentDir);
	process.env.HARNESS_PROBE_OUT = out;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_LATENCY_INTERVAL_MS = "1000";
	process.env.PI_LATENCY_STALL_BLOCK_MS = "60";
	proc.files.set("/proc/version", "Linux version 6.6.87.2-microsoft-standard-WSL2\n");
	proc.files.set(
		"/proc/self/mountinfo",
		[
			"22 1 8:1 / / rw - ext4 /dev/sda rw",
			`40 22 0:5 / ${root} rw - 9p drvfs rw`,
			"41 22 0:6 / /elsewhere rw - tmpfs tmpfs rw",
			"malformed",
		].join("\n"),
	);
	const { tui, written } = fakeTui();
	const start = register().get("session_start");
	assert.ok(start);
	await start({}, context(tui));

	assert.ok(stdinData);
	stdinData();
	stdinData();
	tui.terminal.write("frame-1");
	tui.terminal.write("ü");
	vi.advanceTimersByTime(1499);
	assert.equal(stalled, 0, "the self-test stall is not due before 1.5 s");
	vi.advanceTimersByTime(501);
	assert.equal(stalled, 60, "the self-test stall fired once, for PI_LATENCY_STALL_BLOCK_MS");
	assert.deepEqual(written, ["frame-1", "ü"]);

	const [first, second, third, ...rest] = records(out);
	assert.equal(rest.length, 0);
	assert.ok(first && second && third);
	assert.equal(first.kind, "start");
	assert.equal(first.wsl, true);
	assert.equal(first.tui, true);
	const startFs = first.fs as { type: string; stat_ms: number; fsync_ms: number };
	assert.equal(startFs.type, "9p");
	assert.deepEqual(startFs, { type: "9p", stat_ms: 0, fsync_ms: 0 });
	assert.deepEqual(fs.readdirSync(agentDir), [], "the fsync scratch file is removed");

	// Window one, 0-1 s: two writes (9 bytes, `ü` is two), one paint after the first input, no lag.
	assert.equal(second.kind, "summary");
	assert.equal(second.window_s, 1);
	assert.deepEqual(second.write, { bytes: 9, calls: 2, max_block_ms: 0, total_block_ms: 0, bytes_per_s: 9 });
	assert.deepEqual(second.input_to_paint_ms, [0]);
	assert.deepEqual(second.loop_lag_ms, { p50: 0, p95: 0, p99: 0, max: 0 });
	assert.deepEqual(second.stalls, []);

	// Window two, 1-2 s: the stall fired first at 1.5 s, so that tick ran 60 ms late; the other 99 on time.
	assert.equal(third.kind, "summary");
	assert.equal(third.window_s, 1.06);
	assert.deepEqual(third.stalls, [{ at: (first.t as number) + 1500, ms: 60 }]);
	assert.deepEqual(third.loop_lag_ms, { p50: 0, p95: 0, p99: 0, max: 60 });
	assert.deepEqual(third.write, { bytes: 0, calls: 0, max_block_ms: 0, total_block_ms: 0, bytes_per_s: 0 });
	assert.deepEqual(third.input_to_paint_ms, []);
});

test("elsewhere it falls back to the platform, tolerates a missing agent dir and flushes on exit", async () => {
	const out = join(root, "latency.jsonl");
	process.env.PI_LATENCY_PROBE = out;
	process.env.HARNESS_PROBE_OUT = join(root, "unused.jsonl");
	process.env.PI_CODING_AGENT_DIR = join(root, "missing");
	const start = register().get("session_start");
	assert.ok(start);
	await start({}, context(undefined));
	await start({}, context(undefined));
	const flush = exitFlush();
	assert.ok(flush);
	flush();
	assert.equal(fs.existsSync(join(root, "unused.jsonl")), false);

	const [first, summary, ...rest] = records(out);
	assert.equal(rest.length, 0, "a second session_start does not start a second probe");
	assert.ok(first && summary);
	assert.equal(first.wsl, false);
	assert.equal(first.tui, false);
	assert.deepEqual(first.fs, { type: process.platform, stat_ms: -1, fsync_ms: -1 });
	assert.equal(summary.kind, "summary");
	assert.deepEqual(summary.loop_lag_ms, { p50: 0, p95: 0, p99: 0, max: 0 });
	assert.deepEqual(summary.fs, { type: process.platform, stat_ms: -1, fsync_ms: -1 });
});

test("summarises every five seconds by default, with percentiles over the window's ticks", async () => {
	const out = join(root, "latency.jsonl");
	process.env.PI_LATENCY_PROBE = out;
	process.env.PI_CODING_AGENT_DIR = root;
	const start = register().get("session_start");
	assert.ok(start);
	await start({}, context(undefined));
	vi.advanceTimersByTime(4999);
	assert.equal(records(out).length, 1);
	vi.advanceTimersByTime(1);
	const summary = records(out)[1];
	assert.ok(summary);
	const lag = summary.loop_lag_ms as { p50: number; p95: number; p99: number; max: number };
	assert.deepEqual(lag, { p50: 0, p95: 0, p99: 0, max: 0 });
	assert.equal(summary.window_s, 5);
	assert.equal(fs.readdirSync(root).filter((name) => name.startsWith(".latency-probe-")).length, 0);
});
