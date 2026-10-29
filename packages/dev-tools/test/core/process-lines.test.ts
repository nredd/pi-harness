import { ChildProcess, spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { run } from "../../src/core/process.ts";

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: vi.fn(),
}));

describe.each(["before stderr drains", "after stderr drains"])("run when the leader exits %s", (exitOrder) => {
	it.each([
		{ name: "an oversized line followed by a short line", chunks: [`${"z".repeat(101)}\ntail\n`], lines: ["tail"] },
		{
			name: "short lines whose combined length exceeds the cap",
			chunks: ["a\n".repeat(60)],
			lines: Array(60).fill("a"),
		},
		{
			name: "a valid line before an oversized line",
			chunks: [`head\n${"z".repeat(101)}\ntail\n`],
			lines: ["head", "tail"],
		},
		{ name: "an oversized line spanning chunks", chunks: ["z".repeat(100), "z\ntail\n"], lines: ["tail"] },
		{
			name: "a dropped line continuing until its newline",
			chunks: ["z".repeat(101), "suffix", "\ntail\n"],
			lines: ["tail"],
		},
		{ name: "a dropped line ending without a newline", chunks: ["z".repeat(101), "suffix"], lines: [] },
		{ name: "a valid partial line after a dropped line", chunks: [`${"z".repeat(101)}\ntail`], lines: ["tail"] },
		{
			name: "a line at the cap followed by its newline",
			chunks: ["z".repeat(100), "\ntail\n"],
			lines: ["z".repeat(100), "tail"],
		},
		{
			name: "CRLF and empty lines after a dropped line",
			chunks: [`${"z".repeat(101)}\n\ntail\r\n`],
			lines: ["", "tail"],
		},
	])("preserves $name", async ({ chunks, lines: expected }) => {
		// Drive the real runner with fixed data-event boundaries, independent of pipe scheduling.
		vi.mocked(spawn).mockImplementationOnce(() => {
			const child = new ChildProcess();
			Object.defineProperties(child, {
				stdout: { value: new PassThrough() },
				stderr: { value: new PassThrough() },
			});
			queueMicrotask(() => {
				if (exitOrder === "before stderr drains") child.emit("exit", 0, null);
				for (const chunk of chunks) child.stderr?.emit("data", Buffer.from(chunk));
				child.stderr?.emit("end");
				if (exitOrder === "after stderr drains") child.emit("exit", 0, null);
				child.emit("close", 0, null);
			});
			return child;
		});
		const lines: string[] = [];
		const result = await run({
			cmd: "fixture",
			args: [],
			maxBytes: 100,
			onStderrLine: (line) => {
				lines.push(line);
				throw new Error("listener boom");
			},
		});
		expect(result.exitCode).toBe(0);
		expect(lines).toEqual(expected);
		const text = chunks.join("");
		expect(result.stderr).toBe(text.slice(0, 100));
		expect(result.stderrDropped).toBe(Math.max(0, text.length - 100));
	});
});
