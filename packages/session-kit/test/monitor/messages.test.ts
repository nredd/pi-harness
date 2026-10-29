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

	it("formats signal, stopped and timeout lifecycle outcomes", () => {
		for (const [status, expected] of [
			["exited", "died from SIGTERM after 0s"],
			["stopped", "stopped after 0s"],
			["timeout", "timed out after 0s and was killed"],
		] as const) {
			const message = formatMessage(info({ status, signal: status === "exited" ? "SIGTERM" : null, endedAt: 0 }), [], {
				final: true,
				wake: true,
			});
			expect(message.text).toContain(expected);
		}
	});

	it("sorts retained and dropped matches by line number without mutating the batch", () => {
		const batch = {
			items: [line(8, "last", true), line(9, "quiet")],
			dropped: 2,
			droppedMatched: true,
			droppedMatches: [line(4, "middle", true), line(2, "first", true)],
		};
		const before = structuredClone(batch);
		const message = formatMessage(info({ lines: 9 }), batch, { final: false, wake: true, since: 1 });
		expect(message.text).toBe(
			'[monitor m1 "build"]\nmatched lines 2: first; 8: last\nmonitor_read {"id":"m1","since":1}',
		);
		expect(message.details.matched).toEqual([2, 4, 8]);
		expect(batch).toEqual(before);
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
