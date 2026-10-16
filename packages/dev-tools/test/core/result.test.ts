import { describe, expect, it } from "vitest";
import type { RunResult } from "../../src/core/process.ts";
import { abnormalExit, seconds, toolResult } from "../../src/core/result.ts";

const base: RunResult = {
	exitCode: 0,
	termSignal: null,
	stdout: "",
	stderr: "",
	stdoutDropped: 0,
	stderrDropped: 0,
	timedOut: false,
	aborted: false,
	durationMs: 1500,
};

describe("abnormalExit", () => {
	it("is undefined for a normal exit, any code", () => {
		expect(abnormalExit(base, "x")).toBeUndefined();
		expect(abnormalExit({ ...base, exitCode: 101 }, "x")).toBeUndefined();
	});
	it("prefers aborted over everything", () => {
		expect(abnormalExit({ ...base, exitCode: null, aborted: true, spawnError: "nope" }, "x")).toBe(
			"x: aborted after 1.5s",
		);
	});
	it("names spawn errors, timeouts and signals", () => {
		expect(abnormalExit({ ...base, exitCode: null, spawnError: "ENOENT" }, "x")).toBe("x: could not start: ENOENT");
		expect(abnormalExit({ ...base, exitCode: null, timedOut: true }, "x")).toBe("x: timed out after 1.5s");
		expect(abnormalExit({ ...base, exitCode: null, termSignal: "SIGSEGV" }, "x")).toBe("x: killed by SIGSEGV");
	});
});

describe("toolResult", () => {
	it("shapes content, structured content, details and isError", () => {
		const r = toolResult({ text: "t", structured: { a: 1 }, details: { d: true } });
		expect(r.content).toEqual([{ type: "text", text: "t" }]);
		expect(r.structuredContent).toEqual({ a: 1 });
		expect(r.details).toEqual({ d: true });
		expect(r.isError).toBe(false);
		expect(toolResult({ text: "t", structured: null, isError: true }).isError).toBe(true);
	});
});

describe("seconds", () => {
	it("formats to one decimal", () => {
		expect(seconds(1234)).toBe("1.2s");
	});
});
