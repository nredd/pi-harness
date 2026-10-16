import { describe, expect, it } from "vitest";
import { formatDuration, formatMessage, MAX_MESSAGE_LINES } from "../../src/monitor/messages.ts";
import type { MonitorInfo } from "../../src/monitor/types.ts";

const info = (over: Partial<MonitorInfo> = {}): MonitorInfo => ({
	id: "m1",
	name: "build",
	argv: ["make"],
	pid: 1,
	status: "running",
	startedAt: 0,
	exitCode: null,
	signal: null,
	lines: 3,
	wake: false,
	timeoutMs: 1000,
	...over,
});
const line = (n: number, text = `l${n}`, matched = false) => ({ n, text, matched });

describe("formatMessage", () => {
	it("numbers lines, flags matches and carries wake through", () => {
		const m = formatMessage(info(), [line(1), line(2, "boom", true)], { final: false, wake: true });
		expect(m.text).toBe('[monitor m1 "build"] lines 1-2 (2 new; match on 2)\n1: l1\n2: boom');
		expect(m.wake).toBe(true);
		expect(m.details).toMatchObject({ id: "m1", firstLine: 1, lastLine: 2, matched: [2], status: "running" });
	});

	it("keeps only the newest lines and says how to get the rest", () => {
		const many = Array.from({ length: 100 }, (_, i) => line(i + 1));
		const m = formatMessage(info({ lines: 100 }), many, { final: false, wake: false });
		expect(m.text.split("\n")).toHaveLength(1 + 1 + MAX_MESSAGE_LINES);
		expect(m.text).toContain('60 earlier lines omitted; monitor_read {"id":"m1","since":0}');
		expect(m.text).toContain("100: l100");
		expect(m.text).not.toContain("\n1: l1\n");
	});

	it("bounds bytes but always keeps the newest line", () => {
		const big = "x".repeat(6000);
		const m = formatMessage(info(), [line(1, big), line(2, big), line(3, big)], { final: false, wake: false });
		expect(m.text).toContain("3: ");
		expect(Buffer.byteLength(m.text)).toBeLessThan(16 * 1024);
		expect(m.text).toContain("earlier lines omitted");
	});

	it("appends an exit note for each end state", () => {
		const done = (over: Partial<MonitorInfo>) =>
			formatMessage(info({ endedAt: 65_000, ...over }), [], { final: true, wake: true }).text;
		expect(done({ status: "exited", exitCode: 2 })).toContain("exited with code 2 after 1m05s; 3 lines total");
		expect(done({ status: "exited", signal: "SIGSEGV" })).toContain("died from SIGSEGV");
		expect(done({ status: "timeout" })).toContain("timed out");
		expect(done({ status: "stopped" })).toContain("stopped after");
	});
});

describe("formatDuration", () => {
	it.each([
		[0, "0s"],
		[59_400, "59s"],
		[61_000, "1m01s"],
		[3_660_000, "1h01m"],
	])("%d ms -> %s", (ms, out) => expect(formatDuration(ms)).toBe(out));
});
