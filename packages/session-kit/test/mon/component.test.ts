import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { MonView } from "../../src/mon/component.ts";
import { sortProcesses, sparkline } from "../../src/mon/model.ts";
import { snapshot } from "./fixtures.ts";

const theme = { fg: (_color: string, s: string) => s, bg: (_color: string, s: string) => s, bold: (s: string) => s };
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

	it("composes wide cards side by side and stacks medium cards", () => {
		const { v } = view(40);
		expect(v.render(120).find((line) => line.includes("CPU / interval"))).toContain("MEMORY / load");
		expect(v.render(80).find((line) => line.includes("CPU / interval"))).not.toContain("MEMORY / load");
		expect(v.render(40).join("\n")).not.toContain("CPU / interval");
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

	it("bounds history at 120 and shows stale/warming states without inventing zero", () => {
		const { v } = view();
		for (let i = 0; i < 150; i++) v.update(snapshot(i % 100));
		expect(v.state.historyLength).toBe(120);
		v.update({ ...snapshot(), status: "stale", notice: "Collector unavailable" });
		expect(v.render(80).join("\n")).toContain("STALE");
		v.update({ ...snapshot(), status: "warming", cpuPercent: null });
		const text = v.render(80).join("\n");
		expect(text).toContain("WARMING");
		expect(text).toContain("--");
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
