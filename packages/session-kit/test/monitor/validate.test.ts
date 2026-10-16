import { describe, expect, it } from "vitest";
import { MAX_MONITORS, validateStart } from "../../src/monitor/validate.ts";

const base = { argv: ["tail", "-f", "x"], name: "logs" };
const none = new Set<string>();

describe("validateStart", () => {
	it("accepts a minimal request with defaults", () => {
		const r = validateStart(base, none, 0);
		expect(r).toMatchObject({ ok: true, value: { wake: false, timeoutMs: 3_600_000, regex: undefined } });
	});

	it.each([
		[{ ...base, argv: [] }, /non-empty array/],
		[{ ...base, argv: ["", "x"] }, /argv\[0\]/],
		[{ ...base, argv: ["  "] }, /argv\[0\]/],
		[{ ...base, argv: ["a\0b"] }, /NUL/],
		[{ ...base, name: "" }, /name must/],
		[{ ...base, name: "has space" }, /name must/],
		[{ ...base, name: "-lead" }, /name must/],
		[{ ...base, name: "x".repeat(41) }, /name must/],
		[{ ...base, match: "(" }, /valid regex/],
		[{ ...base, match: "a".repeat(501) }, /at most 500/],
		[{ ...base, timeout_s: 0 }, /timeout_s/],
		[{ ...base, timeout_s: 90_000 }, /timeout_s/],
		[{ ...base, timeout_s: Number.NaN }, /timeout_s/],
	])("rejects %j", (input, error) => {
		const r = validateStart(input, none, 0);
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.error).toMatch(error);
	});

	it("rejects a duplicate live name and the concurrency cap", () => {
		expect(validateStart(base, new Set(["logs"]), 1)).toMatchObject({ ok: false });
		expect(validateStart(base, none, MAX_MONITORS)).toMatchObject({ ok: false });
		expect(validateStart(base, none, MAX_MONITORS - 1).ok).toBe(true);
	});

	it("compiles match and honours wake and timeout_s", () => {
		const r = validateStart({ ...base, match: "ERR(OR)?", wake: true, timeout_s: 5 }, none, 0);
		expect(r.ok && r.value.regex?.test("an ERROR")).toBe(true);
		expect(r.ok && r.value.wake).toBe(true);
		expect(r.ok && r.value.timeoutMs).toBe(5000);
	});
});
