import { readFile } from "node:fs/promises";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { bound, capList, tailLines } from "../../src/core/output.ts";

const manyLines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

describe("bound", () => {
	it("passes short text through", async () => {
		const b = await bound("hi");
		expect(b).toEqual({ text: "hi", truncated: false });
	});

	it("keeps the tail, spills the full text, and names the file", async () => {
		const text = manyLines(3000);
		const b = await bound(text, { keep: "tail", label: "t" });
		expect(b.truncated).toBe(true);
		expect(b.text).toContain("line 2999");
		expect(b.text).not.toMatch(/^line 0\n/);
		expect(b.text).toContain("truncated at the start");
		expect(b.fullOutputPath).toMatch(/pi-dev-tools-[^/]+\/t-\d+\.txt$/);
		expect(await readFile(b.fullOutputPath as string, "utf8")).toBe(text);
	});

	it("keeps the head by default and mentions producer drops", async () => {
		const b = await bound(manyLines(3000), { alreadyDropped: 42 });
		expect(b.text).toMatch(/^line 0\n/);
		expect(b.text).toContain("truncated at the end");
		expect(b.text).toContain("dropped 42 more bytes");
	});

	it("stays within the limits, notice included", async () => {
		const byLines = await bound(manyLines(DEFAULT_MAX_LINES * 2));
		expect(byLines.text.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
		const byBytes = await bound("x".repeat(DEFAULT_MAX_BYTES * 2));
		expect(Buffer.byteLength(byBytes.text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
	});

	it("reuses one spill directory per process", async () => {
		const a = await bound(manyLines(3000));
		const b = await bound(manyLines(3000));
		expect(a.fullOutputPath?.replace(/\/[^/]+$/, "")).toBe(b.fullOutputPath?.replace(/\/[^/]+$/, ""));
		expect(a.fullOutputPath).not.toBe(b.fullOutputPath);
	});

	it("honours custom limits", async () => {
		const b = await bound(manyLines(50), { maxLines: 12, maxBytes: 10_000 });
		expect(b.truncated).toBe(true);
		expect(b.text.split("\n").length).toBeLessThanOrEqual(12);
	});
});

describe("helpers", () => {
	it("tailLines keeps the last n and handles 0", () => {
		expect(tailLines("a\nb\nc", 2)).toBe("b\nc");
		expect(tailLines("a", 5)).toBe("a");
		expect(tailLines("a\nb", 0)).toBe("");
	});
	it("capList reports dropped", () => {
		expect(capList([1, 2, 3], 2)).toEqual({ kept: [1, 2], dropped: 1 });
		expect(capList([1], 2)).toEqual({ kept: [1], dropped: 0 });
	});
});
