import { describe, expect, it } from "vitest";
import { formatDuration, formatMessage } from "../../src/monitor/messages.ts";
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
	matches: 0,
	lines: 3,
	wake: false,
	timeoutMs: 1000,
	...over,
});
const line = (n: number, text = `l${n}`, matched = false) => ({ n, text, matched });

describe("formatMessage", () => {
	it("reports the matched line and cursor without replaying its passive batch", () => {
		const message = formatMessage(info(), [line(1), line(2, "boom", true)], { final: false, wake: true });
		expect(message.text).toBe('[monitor m1 "build"]\nmatched line 2: boom\nmonitor_read {"id":"m1","since":0}');
		expect(message.wake).toBe(true);
		expect(message.details).toMatchObject({ id: "m1", firstLine: 1, lastLine: 2, matched: [2], status: "running" });
	});

	it("reports a final lifecycle event and cursor without buffered output", () => {
		const message = formatMessage(info({ endedAt: 65_000, status: "exited", exitCode: 2 }), [line(1, "quiet")], {
			final: true,
			wake: true,
		});
		expect(message.text).toContain("exited with code 2 after 1m05s");
		expect(message.text).toContain('monitor_read {"id":"m1","since":0}');
		expect(message.text).not.toContain("quiet");
	});

	it("keeps dropped matched-line evidence in the wake", () => {
		const message = formatMessage(
			info({ lines: 250 }),
			{
				items: [line(1, "unrelated")],
				dropped: 249,
				droppedMatched: true,
				droppedMatches: [line(201, "MATCH lost", true)],
			},
			{ final: false, wake: true },
		);
		expect(message.text).toContain("matched line 201: MATCH lost");
		expect(message.details.matched).toEqual([201]);
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
