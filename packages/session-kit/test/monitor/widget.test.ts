import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { MonitorInfo } from "../../src/monitor/types.ts";
import { formatSummary } from "../../src/monitor/widget.ts";

const theme = { fg: (_color: string, text: string) => text };
const unstyle = (text: string) => text.replaceAll(`${String.fromCharCode(27)}[0m`, "");
const monitor = (over: Partial<MonitorInfo> = {}): MonitorInfo => ({
	id: "m1",
	name: "ci-56",
	argv: ["make"],
	pid: 1,
	status: "running",
	startedAt: 0,
	exitCode: null,
	signal: null,
	lines: 4,
	lastLine: "pass=6 pending=3",
	wake: false,
	timeoutMs: 3_600_000,
	...over,
});

describe("monitor widget", () => {
	it("renders one compact row with the newest output", () => {
		expect(formatSummary([monitor()], 7 * 60_000, 80, theme).map(unstyle)).toEqual([
			"● 1 monitor  ci-56 7m00s 4 lines last: pass=6 pending=3",
		]);
	});

	it("prefers the last-line preview and newest monitor at narrow and multi-monitor widths", () => {
		const monitors = [
			monitor({ name: "old", startedAt: 0, lastLine: "old progress" }),
			monitor({ id: "m2", name: "new", startedAt: 60_000, lastLine: "new progress" }),
		];
		expect(formatSummary(monitors, 7 * 60_000, 40, theme).map(unstyle)).toEqual([
			"● 2 monitors  new 6m00s 4 lines last: n…",
		]);
		expect(formatSummary(monitors, 7 * 60_000, 100, theme).map(unstyle)).toEqual([
			"● 2 monitors  old 7m00s 4 lines last: old progress  new 6m00s 4 lines last: new progress",
		]);
	});

	it("measures wide last-line output in terminal columns", () => {
		const [line] = formatSummary([monitor({ lastLine: "進捗=".repeat(20) })], 7 * 60_000, 65, theme);
		expect(visibleWidth(line ?? "")).toBeLessThanOrEqual(65);
		expect(unstyle(line ?? "")).toContain("…");
	});
});
