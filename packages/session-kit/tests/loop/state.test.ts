import { describe, expect, it } from "vitest";
import {
	DEFAULT_MAX_RUNS,
	decideTick,
	describeLoop,
	formatInterval,
	type LoopEntry,
	MAX_RUNS_CEILING,
	parseInterval,
	parseLoopArgs,
	type TickInput,
} from "../../src/loop/state.ts";

describe("parseInterval", () => {
	it.each([
		["30s", 30_000],
		["5m", 300_000],
		["1h", 3_600_000],
		["90S", 90_000],
		["24h", 86_400_000],
	])("%s -> %d", (raw, ms) => expect(parseInterval(raw)).toEqual({ ok: true, ms }));
	it.each(["29s", "0m", "25h", "5", "m", "5 m", "1.5h", "-5m", "10d", ""])("rejects %j", (raw) =>
		expect(parseInterval(raw)).toMatchObject({ ok: false }),
	);
	it("names the 30s minimum", () => {
		expect(parseInterval("10s")).toMatchObject({ error: expect.stringContaining("30s minimum") });
	});
});

describe("formatInterval", () => {
	it("picks the largest exact unit", () => {
		expect(formatInterval(30_000)).toBe("30s");
		expect(formatInterval(90_000)).toBe("90s");
		expect(formatInterval(300_000)).toBe("5m");
		expect(formatInterval(7_200_000)).toBe("2h");
	});
});

describe("parseLoopArgs", () => {
	it("lists on nothing or `list`", () => {
		expect(parseLoopArgs("")).toEqual({ kind: "list" });
		expect(parseLoopArgs(" list ")).toEqual({ kind: "list" });
	});
	it("starts a loop with the default cap", () => {
		expect(parseLoopArgs("5m check the build")).toEqual({
			kind: "start",
			intervalMs: 300_000,
			prompt: "check the build",
			maxRuns: DEFAULT_MAX_RUNS,
		});
	});
	it("takes --max anywhere after the interval and clamps it to the run cap", () => {
		expect(parseLoopArgs("30s --max 3 ping")).toMatchObject({ maxRuns: 3, prompt: "ping" });
		expect(parseLoopArgs("30s ping --max=7")).toMatchObject({ maxRuns: 7, prompt: "ping" });
		expect(parseLoopArgs("30s ping --max 50")).toMatchObject({ maxRuns: MAX_RUNS_CEILING });
		expect(parseLoopArgs("30s ping --max 51")).toMatchObject({ maxRuns: MAX_RUNS_CEILING });
	});
	it("rejects unsafe or non-positive --max values, bad intervals and missing prompts", () => {
		expect(parseLoopArgs("30s ping --max 999999999999999999999999999999999999999")).toMatchObject({ kind: "error" });
		expect(parseLoopArgs("30s ping --max 0")).toMatchObject({ kind: "error" });
		expect(parseLoopArgs("30s ping --max -1")).toMatchObject({ kind: "error" });
		expect(parseLoopArgs("30s ping --max")).toMatchObject({ kind: "error" });
		expect(parseLoopArgs("10s ping")).toMatchObject({ kind: "error" });
		expect(parseLoopArgs("check the build")).toMatchObject({ kind: "error" });
		expect(parseLoopArgs("5m")).toMatchObject({ kind: "error" });
	});
	it("parses stop and resume, defaulting to all", () => {
		expect(parseLoopArgs("stop")).toEqual({ kind: "stop", target: "all" });
		expect(parseLoopArgs("stop 2")).toEqual({ kind: "stop", target: "2" });
		expect(parseLoopArgs("resume all")).toEqual({ kind: "resume", target: "all" });
		expect(parseLoopArgs("stop 1 2")).toMatchObject({ kind: "error" });
	});
});

describe("decideTick matrix", () => {
	const loop = (patch: Partial<LoopEntry> = {}): LoopEntry => ({
		id: "1",
		intervalMs: 30_000,
		prompt: "p",
		maxRuns: 3,
		runs: 0,
		skipped: 0,
		...patch,
	});
	const base = (patch: Partial<TickInput> = {}): TickInput => ({
		isChild: false,
		busy: false,
		goalActive: false,
		planMode: false,
		loop: loop(),
		...patch,
	});

	it("fires when idle and unobstructed", () => expect(decideTick(base())).toEqual({ fire: true }));
	it.each<[string, Partial<TickInput>, string]>([
		["a child session", { isChild: true }, "child session"],
		["a paused loop", { loop: loop({ paused: "provider error" }) }, "paused"],
		["the run cap", { loop: loop({ runs: 3 }) }, "run cap reached"],
		["an active goal", { goalActive: true }, "goal active"],
		["plan mode", { planMode: true }, "plan mode"],
		["a busy agent", { busy: true }, "agent busy"],
	])("skips for %s", (_n, patch, reason) => expect(decideTick(base(patch))).toEqual({ fire: false, reason }));
});

describe("describeLoop", () => {
	it("shows interval, progress, skips and a pause", () => {
		const text = describeLoop({
			id: "2",
			intervalMs: 300_000,
			prompt: "x".repeat(80),
			maxRuns: 50,
			runs: 4,
			skipped: 1,
			paused: "provider error",
		});
		expect(text).toContain("2: every 5m, 4/50 runs, 1 skipped");
		expect(text).toContain("...");
		expect(text).toContain("[paused: provider error]");
	});
});
