import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { MonView } from "../../src/mon/component.ts";
import { sortProcesses, sparkline, timeHistory, timeHistoryRows } from "../../src/mon/model.ts";
import { snapshot } from "./fixtures.ts";

const theme = { fg: (_color: string, s: string) => s, bg: (_color: string, s: string) => s, bold: (s: string) => s };
/**
 * Build a dashboard with identity theme and spied callbacks.
 * @param rows Available terminal height.
 * @returns Initialized view and its injectable options.
 */
function view(rows = 24) {
	const options = { theme, rows: () => rows, requestRender: vi.fn(), onClose: vi.fn() };
	const v = new MonView(options);
	v.update(snapshot());
	return { v, options };
}

describe("mon responsive dashboard", () => {
	it.each([
		[40, 12],
		[60, 20],
		[80, 24],
		[120, 40],
		[100, 16],
		[99, 16],
		[1, 1],
		[20, 3],
		[200, 4],
	])("fits %ix%i with reachable close/help", (width, height) => {
		const { v } = view(height);
		for (const help of [false, true]) {
			if (help) v.handleInput("?");
			const lines = v.render(width);
			expect(lines).toHaveLength(height);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			if (width >= 25) expect(lines.at(-1)).toContain("? help");
			if (width >= 12) expect(lines.at(-1)).toContain("q/Esc close");
		}
	});

	it.each([6, 8, 9, 12, 16, 20])("keeps selection visible at %i rows even with stale diagnostics", (height) => {
		const { v } = view(height);
		v.update({ ...snapshot(), status: "stale", notice: "Sampling stopped. Close and reopen to retry." });
		for (const key of ["j", "G", "k", "g"]) {
			v.handleInput(key);
			const pid = v.state.selected?.split(":")[0];
			expect(v.render(40).join("\n")).toContain(pid);
		}
	});

	it("scrolls all metric explanations at 40x12 without moving process selection", () => {
		const { v } = view(12);
		const selected = v.state.selected;
		v.handleInput("?");
		const seen: string[] = [];
		for (let i = 0; i < 90; i++) {
			seen.push(...v.render(40));
			v.handleInput("j");
		}
		expect(v.state.selected).toBe(selected);
		for (const text of [
			"interval usage",
			"exceed 100%",
			"unavailable",
			"total-free",
			"compressed pages",
			"footprint, not RSS",
			"pi runs as node",
			"NOT interval CPU",
			"usec reject PID reuse",
			"No native access/builtin FFI",
			"app + wired + compressed",
			"not percent",
			"elapsed time",
			"scheduling",
		])
			expect(seen.join("\n")).toContain(text);
		expect(seen.join("\n")).toContain("PgDn scroll");
		v.handleInput("g");
		expect(v.render(40).join("\n")).toContain("Keys");
		v.handleInput("\u001b[6~");
		expect(v.render(40).join("\n")).not.toContain("Keys");
	});

	it("labels the measurement basis and displays free and swap without calling total-free used memory", () => {
		const { v } = view(40);
		v.update({
			...snapshot(),
			memoryBasis: "app+wired+compressed",
			memoryFreeBytes: 1024 ** 3,
			swapUsedBytes: 3 * 1024 ** 3,
			swapTotalBytes: 4 * 1024 ** 3,
		});
		expect(v.render(120).join("\n")).toContain("used (A+W+C)");
		expect(v.render(120).join("\n")).toContain("free 1.0G swap 3.0G/4.0G");
		v.update({ ...snapshot(), memoryBasis: "total-free" });
		expect(v.render(120).join("\n")).toContain("total-free");
		expect(v.render(40).join("\n")).toContain("T-F");
		expect(v.render(120).join("\n")).not.toContain("non-free");
	});

	it.each([40, 60, 80, 120])(
		"toggles a labelled footprint column at %i columns without replacing failed PIDs by zero",
		(width) => {
			const { v } = view(24);
			v.update({
				...snapshot(),
				processes: snapshot()
					.processes.slice(0, 2)
					.map((p, i) => ({ ...p, footprintBytes: i === 0 ? 800 * 1024 ** 2 : null })),
			});
			v.handleInput("f");
			const lines = v.render(width);
			expect(lines.find((line) => line.includes("NAME"))).toContain("FOOT");
			expect(lines.find((line) => line.includes("1000"))).toContain("800M");
			expect(lines.find((line) => line.includes("1001"))).toContain("--");
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			v.handleInput("f");
			expect(v.render(width).find((line) => line.includes("NAME"))).toContain("RSS");
		},
	);

	it("fills completion-paced history contiguously, right-aligned, with only real gaps dotted", () => {
		// Real cadence is 2000ms plus scan time; drift must not invent gaps.
		/**
		 * Model completion-paced scans plus one genuine pause.
		 * @param i Zero-based sample index.
		 * @returns Monotonic sample milliseconds, with a 15s gap from index six.
		 */
		const at = (i: number) => i * 2023 + (i >= 6 ? 15000 : 0);
		const points = Array.from({ length: 10 }, (_, i) => ({ sampledAtMs: at(i), value: 50 }));
		const line = timeHistory(points.slice(0, 6), 20);
		expect(line).toBe(`${" ".repeat(14)}${"▅".repeat(6)}`);
		const gapped = timeHistory(points, 30);
		expect(gapped.trimStart()).toMatch(/^▅{6}·{7}▅{4}$/);
		const long = Array.from({ length: 120 }, (_, i) => ({ sampledAtMs: i * 2000, value: 50 }));
		const compressed = timeHistory(long, 40);
		expect(compressed).toHaveLength(40);
		expect(compressed).not.toContain(" ");
		expect(compressed).not.toContain("·");
		expect(timeHistory([{ sampledAtMs: 5, value: null }], 4)).toBe("   ·");
	});

	it("preserves irregular elapsed time and reports stale last success", () => {
		expect(
			timeHistory(
				[
					{ sampledAtMs: 0, value: 0 },
					{ sampledAtMs: 1000, value: 100 },
					{ sampledAtMs: 10000, value: 50 },
				],
				11,
			),
		).toBe("▁█········▅");
		const { v } = view();
		v.update({ ...snapshot(), capturedAt: 10000 });
		v.update({ ...snapshot(), capturedAt: 25000, status: "stale" });
		expect(v.render(80).join("\n")).toContain("Last success: 1970-01-01T00:00:10.000Z");
	});

	it("counts a warming or CPU-unavailable collection as a success, separate from CPU state", () => {
		const v = new MonView({ theme, rows: () => 24, requestRender: vi.fn(), onClose: vi.fn() });
		expect(v.render(80)[0]).toContain("WAITING");
		v.update({ ...snapshot(), cpuPercent: null, cpuState: "warming", capturedAt: 10000 });
		let text = v.render(80).join("\n");
		expect(text).toContain("LIVE");
		expect(text).toContain("-- warming · 12 logical CPUs");
		expect(text).not.toContain("WARMING");
		v.update({ ...snapshot(), cpuPercent: null, cpuState: "unavailable", capturedAt: 12000, sampledAtMs: 12000 });
		expect(v.render(80).join("\n")).toContain("-- unavailable · 12 logical CPUs");
		v.update({ ...snapshot(), cpuPercent: null, cpuState: "unavailable", capturedAt: 12000, status: "stale" });
		text = v.render(80).join("\n");
		expect(text).toContain("STALE");
		// Memory/process data came from the 12s collection; it is not "never succeeded".
		expect(text).toContain("Last success: 1970-01-01T00:00:12.000Z");
	});

	it("leaves a leading warming baseline blank and spaces history by monotonic time", () => {
		const v = new MonView({ theme, rows: () => 24, requestRender: vi.fn(), onClose: vi.fn() });
		v.update({ ...snapshot(), cpuPercent: null, cpuState: "warming", sampledAtMs: 0, capturedAt: 0 });
		expect(v.state.historyLength).toBe(0);
		// The wall clock steps back an hour then forward two; monotonic cadence stays regular.
		const walls = [-3_600_000, -3_598_000, 3_600_000, 3_602_000];
		walls.forEach((capturedAt, i) => {
			v.update({ ...snapshot(50), capturedAt, sampledAtMs: (i + 1) * 2000 });
		});
		expect(v.state.historyLength).toBe(4);
		// 50% fills the bottom row of the two-row card chart exactly.
		const history = v.render(80).find((line) => line.includes("█"));
		expect(history).toBeDefined();
		expect(history).not.toContain("·");
		expect(history).toMatch(/[^█]█{4}[^█]/);
		expect(v.render(80).join("\n")).toContain("6.0s span");
	});

	it("adds no history point for a stale snapshot, keeping the last measured value", () => {
		const { v } = view();
		v.update({ ...snapshot(80), sampledAtMs: 12_000 });
		v.update({ ...snapshot(80), sampledAtMs: 12_000, status: "stale" });
		expect(v.state.historyLength).toBe(2);
		const history = v.render(40).find((line) => line.includes("▇"));
		expect(history).toBeDefined();
		expect(history).not.toContain("·");
	});

	it("composes cards side by side from 72 columns and a compact summary below", () => {
		const { v } = view(40);
		expect(v.render(120).find((line) => line.includes("CPU / interval"))).toContain("MEMORY / load");
		expect(v.render(80).find((line) => line.includes("CPU / interval"))).toContain("MEMORY / load");
		const compact = v.render(60).join("\n");
		expect(compact).not.toContain("CPU / interval");
		expect(compact).toContain("CPU 36.2%  RAM 10.4G/24.0G  load 3.21");
		expect(v.render(40).join("\n")).not.toContain("CPU / interval");
	});

	it("draws two-row card history on a fixed scale with gaps on the bottom row only", () => {
		const points = [0, 50, 100, null, 75].map((value, i) => ({ sampledAtMs: i * 2000, value }));
		expect(timeHistoryRows(points, 6, 2)).toEqual([" " + "  █ ▄", " ▁██·█"]);
		expect(timeHistoryRows([], 3, 2)).toEqual(["", ""]);
		expect(timeHistoryRows(points, 6, 1)).toEqual([timeHistory(points, 6)]);
	});

	it("shows RSS share of RAM, a scrollbar only on overflow, and freshness in the header", () => {
		const { v } = view(24);
		v.update({ ...snapshot(), capturedAt: new Date(2026, 9, 23, 13, 4, 5).getTime(), scanMs: 42 });
		const lines = v.render(100);
		expect(lines[0]).toMatch(/● LIVE .*updated 13:04:05 · scan 42ms $/);
		expect(lines.find((line) => line.includes("NAME"))).toMatch(/PID +CPU% +RSS +MEM% +NAME/);
		// 640MiB of 24GiB.
		expect(lines.find((line) => line.includes("1000 "))).toMatch(/640M +2\.6 +fixture-/);
		expect(lines.some((line) => line.endsWith("┃"))).toBe(true);
		const tall = view(80).v.render(100);
		expect(tall.some((line) => line.endsWith("┃"))).toBe(false);
		v.update({ ...snapshot(), status: "stale" });
		expect(v.render(100)[0]).toMatch(/▲ STALE .*last ok 13:04:05 $/);
	});

	it("caches by dimensions and invalidates on update, input and theme changes", () => {
		const { v } = view();
		const a = v.render(80);
		expect(v.render(80)).toBe(a);
		v.invalidate();
		expect(v.render(80)).not.toBe(a);
		const b = v.render(80);
		v.handleInput("j");
		expect(v.render(80)).not.toBe(b);
		v.update(snapshot(70));
		expect(v.render(80).join("\n")).toContain("70.0%");
	});

	it("bounds history at 120 and shows stale and CPU warming states without inventing zero", () => {
		const { v } = view();
		for (let i = 0; i < 150; i++) v.update(snapshot(i % 100));
		expect(v.state.historyLength).toBe(120);
		v.update({ ...snapshot(), status: "stale", notice: "Collector unavailable" });
		expect(v.render(80).join("\n")).toContain("STALE");
		v.update({ ...snapshot(), cpuState: "warming", cpuPercent: null });
		const text = v.render(80).join("\n");
		expect(text).toContain("LIVE");
		expect(text).toContain("-- warming");
	});

	it("keeps identity through refresh and sorts, but not PID reuse", () => {
		const { v } = view();
		v.handleInput("j");
		const selected = v.state.selected;
		v.update({ ...snapshot(), processes: [...snapshot().processes].reverse() });
		expect(v.state.selected).toBe(selected);
		for (const key of ["m", "p", "c", "s"]) {
			v.handleInput(key);
			expect(v.state.selected).toBe(selected);
		}
		v.update({ ...snapshot(), processes: snapshot().processes.map((p) => ({ ...p, identity: `${p.pid}:new` })) });
		expect(v.state.selected).not.toBe(selected);
	});

	it("supports pages, first/last, resize and close", () => {
		let rows = 24;
		const { v, options } = view();
		options.rows = () => rows;
		v.render(80);
		v.handleInput("\u001b[6~");
		expect(v.state.selected).not.toBe("1000:start-1");
		v.handleInput("G");
		v.render(80);
		expect(v.state.scroll).toBeGreaterThan(0);
		rows = 12;
		v.render(40);
		expect(v.state.selected).toBe("1039:start-1");
		v.handleInput("g");
		v.render(40);
		expect(v.state.scroll).toBe(0);
		v.handleInput("q");
		expect(options.onClose).toHaveBeenCalledOnce();
	});

	it("sanitizes malicious process labels and preserves unicode width", () => {
		const { v } = view();
		v.update({
			...snapshot(),
			processes: snapshot()
				.processes.slice(0, 1)
				.map((p) => ({ ...p, name: "界界\u001b[2J\nsecret" })),
		});
		const lines = v.render(40);
		expect(lines.join("\n")).toContain("^[[2J");
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(40);
			expect(stripVTControlCharacters(line)).toBe(line);
		}
	});

	it("shows Darwin process CPU as unavailable while host interval CPU remains available", () => {
		const { v } = view();
		const darwin = snapshot(36.2, "darwin");
		expect(darwin.processes.every((p) => p.cpuPercent === null)).toBe(true);
		v.update(darwin);
		const lines = v.render(80);
		expect(lines.join("\n")).toContain("36.2%");
		expect(lines.join("\n")).toContain("Process CPU unavailable: macOS identity precision");
		expect(lines.find((line) => line.includes("1000"))).toContain("--");
		expect(lines.find((line) => line.includes("1000"))).not.toContain("0.0%");
	});

	it("sorts unknown CPU/RSS last with deterministic ties", () => {
		const processes = snapshot().processes.map((p, i) => ({
			...p,
			cpuPercent: i === 1 ? null : i === 2 ? Number.NaN : 10,
		}));
		expect(
			sortProcesses(processes, "cpu")
				.slice(-2)
				.map((p) => p.pid),
		).toEqual([1001, 1002]);
		expect(sortProcesses(processes, "pid")[0]?.pid).toBe(1000);
		expect(sparkline([null, 0, 100], 3)).toBe("·▁█");
	});
});
