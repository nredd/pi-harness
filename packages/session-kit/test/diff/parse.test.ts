import { describe, expect, it } from "vitest";
import { classifyLines, parseUnifiedDiff, unquoteC } from "../../src/diff/parse.ts";

const MODIFIED = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 keep
-old
+new
+++ looks like a header but is content
@@ -10 +10 @@
-x
+y
`;

describe("parseUnifiedDiff", () => {
	it("splits files, counts hunk lines only, and finds the first hunk", () => {
		const [f] = parseUnifiedDiff(MODIFIED);
		expect(f).toMatchObject({ path: "src/a.ts", status: "modified", additions: 3, deletions: 2, hunkStart: 4 });
		expect(f?.oldPath).toBeUndefined();
	});

	it("classifies lines by position, not prefix", () => {
		const [f] = parseUnifiedDiff(MODIFIED);
		expect(classifyLines(f as never)).toEqual([
			"meta",
			"meta",
			"meta",
			"meta",
			"hunk",
			"context",
			"removed",
			"added",
			"added",
			"hunk",
			"removed",
			"added",
		]);
	});

	it("detects added, deleted, renamed, binary and mode-only files", () => {
		const text = [
			"diff --git a/n.txt b/n.txt",
			"new file mode 100644",
			"--- /dev/null",
			"+++ b/n.txt",
			"@@ -0,0 +1 @@",
			"+hi",
			"diff --git a/d.txt b/d.txt",
			"deleted file mode 100644",
			"--- a/d.txt",
			"+++ /dev/null",
			"@@ -1 +0,0 @@",
			"-bye",
			"diff --git a/old name.txt b/new name.txt",
			"similarity index 90%",
			"rename from old name.txt",
			"rename to new name.txt",
			"diff --git a/img.png b/img.png",
			"index 1..2 100644",
			"Binary files a/img.png and b/img.png differ",
			"diff --git a/run.sh b/run.sh",
			"old mode 100644",
			"new mode 100755",
		].join("\n");
		const files = parseUnifiedDiff(text);
		expect(files.map((f) => [f.path, f.status])).toEqual([
			["n.txt", "added"],
			["d.txt", "deleted"],
			["new name.txt", "renamed"],
			["img.png", "binary"],
			["run.sh", "mode"],
		]);
		expect(files[2]?.oldPath).toBe("old name.txt");
	});

	it("reads paths with spaces from the header and +++ tab suffix", () => {
		const [f] = parseUnifiedDiff(
			"diff --git a/a b/c.txt b/a b/c.txt\n--- a/a b/c.txt\t\n+++ b/a b/c.txt\t\n@@ -1 +1 @@\n-x\n+y\n",
		);
		expect(f?.path).toBe("a b/c.txt");
	});

	it("decodes quoted paths", () => {
		expect(unquoteC('"a\\tb\\"c"')).toBe('a\tb"c');
		expect(unquoteC('"caf\\303\\251"')).toBe("caf\u00e9");
		expect(unquoteC("plain")).toBe("plain");
		const [f] = parseUnifiedDiff('diff --git "a/t\\tab" "b/t\\tab"\nnew file mode 100644\n');
		expect(f?.path).toBe("t\tab");
	});

	it("caps per-file lines with a notice but keeps exact counts", () => {
		const body = Array.from({ length: 1000 }, (_, i) => `+line ${i}`).join("\n");
		const text = `diff --git a/big b/big\n--- a/big\n+++ b/big\n@@ -0,0 +1,1000 @@\n${body}\ndiff --git a/small b/small\n--- a/small\n+++ b/small\n@@ -1 +1 @@\n-a\n+b\n`;
		const [big, small] = parseUnifiedDiff(text, 2000);
		expect(big?.additions).toBe(1000);
		expect(big?.lines.length).toBeLessThan(300);
		expect(big?.notice).toMatch(/truncated: \d+ more lines/);
		expect(small).toMatchObject({ path: "small", additions: 1, deletions: 1 });
		expect(small?.notice).toBeUndefined();
	});

	it("returns nothing for empty input", () => {
		expect(parseUnifiedDiff("")).toEqual([]);
	});
});
