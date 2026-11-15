import { describe, expect, it } from "vitest";
import { LineSplitter } from "../../src/monitor/splitter.ts";

const buf = (s: string) => Buffer.from(s, "utf8");

describe("LineSplitter", () => {
	it("joins lines across chunks and flushes the unterminated tail", () => {
		const s = new LineSplitter();
		expect(s.push(buf("ab"))).toEqual([]);
		expect(s.push(buf("c\ndef\ng"))).toEqual(["abc", "def"]);
		expect(s.flush()).toEqual(["g"]);
		expect(s.flush()).toEqual([]);
	});

	it("strips CR from CRLF and keeps blank lines", () => {
		expect(new LineSplitter().push(buf("a\r\n\r\nb\n"))).toEqual(["a", "", "b"]);
	});

	it("does not split a multibyte character across chunks", () => {
		const bytes = buf("h\u00e9llo\n");
		const s = new LineSplitter();
		expect(s.push(bytes.subarray(0, 2))).toEqual([]);
		expect(s.push(bytes.subarray(2))).toEqual(["h\u00e9llo"]);
	});

	it("truncates an overlong line once and drops the rest of it", () => {
		const s = new LineSplitter(10);
		const out = [...s.push(buf("x".repeat(25))), ...s.push(buf("y".repeat(25))), ...s.push(buf("zz\nnext\n"))];
		expect(out).toHaveLength(2);
		expect(out[0]).toBe(`${"x".repeat(10)} ...[line truncated]`);
		expect(out[1]).toBe("next");
		expect(s.flush()).toEqual([]);
	});

	it("truncates an overlong line that arrives in one chunk with its newline", () => {
		const out = new LineSplitter(5).push(buf("abcdefgh\nok\n"));
		expect(out).toEqual(["abcde ...[line truncated]", "ok"]);
	});
});
