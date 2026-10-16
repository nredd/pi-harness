import { describe, expect, it } from "vitest";
import {
	formatRule,
	formatRules,
	INJECTED_ENTRY,
	injectedKeys,
	MAX_RULE_BYTES,
	matchesRule,
	parseRule,
	relativeToCwd,
	truncateUtf8,
} from "../../src/rules/logic.ts";

describe("parseRule", () => {
	it("parses a list of globs", () => {
		const rule = parseRule("project:a.md", "---\npaths:\n  - src/**/*.ts\n  - '*.md'\n---\nUse tabs.\n");
		expect(rule?.globs).toEqual(["src/**/*.ts", "*.md"]);
		expect(rule?.body).toBe("Use tabs.");
	});
	it("accepts a single string", () => {
		expect(parseRule("x", "---\npaths: src/**\n---\nbody")?.globs).toEqual(["src/**"]);
	});
	it("ignores files without paths, with empty paths, empty body, or bad YAML", () => {
		expect(parseRule("x", "just text")).toBeUndefined();
		expect(parseRule("x", "---\ntitle: a\n---\nbody")).toBeUndefined();
		expect(parseRule("x", "---\npaths: []\n---\nbody")).toBeUndefined();
		expect(parseRule("x", "---\npaths: [a]\n---\n   ")).toBeUndefined();
		expect(parseRule("x", "---\npaths: [unclosed\n---\nbody")).toBeUndefined();
		expect(parseRule("x", "---\npaths: [1, 2]\n---\nbody")).toBeUndefined();
	});
});

describe("relativeToCwd", () => {
	it("handles relative, absolute, @-prefixed and ~ paths", () => {
		expect(relativeToCwd("src/a.ts", "/w")).toBe("src/a.ts");
		expect(relativeToCwd("./src/../src/a.ts", "/w")).toBe("src/a.ts");
		expect(relativeToCwd("/w/src/a.ts", "/w")).toBe("src/a.ts");
		expect(relativeToCwd("@src/a.ts", "/w")).toBe("src/a.ts");
		expect(relativeToCwd("~/p/a.ts", "/h/p/..", "/h")).toBe("p/a.ts");
	});
	it("rejects paths outside cwd and cwd itself", () => {
		expect(relativeToCwd("../x.ts", "/w")).toBeUndefined();
		expect(relativeToCwd("/etc/passwd", "/w")).toBeUndefined();
		expect(relativeToCwd("/w", "/w")).toBeUndefined();
		expect(relativeToCwd("/wx/a.ts", "/w")).toBeUndefined();
		expect(relativeToCwd("~/a.ts", "/w", "/h")).toBeUndefined();
	});
});

describe("matchesRule", () => {
	const rule = (...globs: string[]) => ({ id: "x", globs, body: "b" });
	it("matches globs against cwd-relative paths", () => {
		expect(matchesRule(rule("src/**/*.ts"), "src/a/b.ts")).toBe(true);
		expect(matchesRule(rule("src/**/*.ts"), "lib/a.ts")).toBe(false);
		expect(matchesRule(rule("*.ts"), "src/a.ts")).toBe(false);
		expect(matchesRule(rule("nope", "{src,lib}/*.ts"), "lib/a.ts")).toBe(true);
	});
});

describe("formatRule / formatRules", () => {
	const rule = (body: string, id = "project:a.md") => ({ id, globs: ["a"], body });
	const head = "\n\n[pi-session-kit rule: project:a.md]\n";
	const headBytes = Buffer.byteLength(head);
	const bytes = (s: string) => Buffer.byteLength(s);

	it("leaves small bodies alone and labels each rule", () => {
		expect(formatRule(rule("Do X"))).toBe(`${head}Do X`);
		const text = formatRules([rule("Do X")]);
		expect(text).toContain("[pi-session-kit rule: project:a.md]");
		expect(text).toContain("Do X");
	});
	it("caps the whole block (label + body + notice) at 4096 bytes around the boundary", () => {
		for (const extra of [-1, 0, 1]) {
			const body = "x".repeat(MAX_RULE_BYTES - headBytes + extra);
			const out = formatRule(rule(body));
			expect(bytes(out)).toBeLessThanOrEqual(MAX_RULE_BYTES);
			if (extra <= 0) expect(out).toBe(head + body);
			else expect(out).toContain("[rule truncated at 4096 bytes]");
		}
	});
	it("never exceeds the cap with multibyte or astral input and never splits a code point", () => {
		for (const unit of ["é", "日", "😈"]) {
			for (let n = 2100; n < 2108; n++) {
				const out = formatRule(rule(unit.repeat(n)));
				expect(bytes(out)).toBeLessThanOrEqual(MAX_RULE_BYTES);
				expect(out).not.toContain("\ufffd");
				expect(out).toContain("[rule truncated");
				expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out)).toBe(false);
			}
		}
	});
	it("a boundary-sized multibyte body just under the cap is kept whole", () => {
		const body = "日".repeat(Math.floor((MAX_RULE_BYTES - headBytes) / 3));
		expect(formatRule(rule(body))).toBe(head + body);
	});
});

describe("truncateUtf8", () => {
	it("cuts on code point boundaries", () => {
		expect(truncateUtf8("a😈b", 4)).toBe("a");
		expect(truncateUtf8("a😈b", 5)).toBe("a😈");
		expect(truncateUtf8("日日", 5)).toBe("日");
		expect(truncateUtf8("abc", 10)).toBe("abc");
		expect(truncateUtf8("abc", 0)).toBe("");
	});
});

describe("injectedKeys", () => {
	const inj = (rule: string) => ({ type: "custom", customType: INJECTED_ENTRY, data: { rule } });
	it("collects keys and forgets everything before a compaction", () => {
		expect(injectedKeys([inj("a"), { type: "custom", customType: "other" }, inj("b")])).toEqual(new Set(["a", "b"]));
		expect(injectedKeys([inj("a"), { type: "compaction" }, inj("b")])).toEqual(new Set(["b"]));
	});
	it("still reads legacy entries that carry a hash", () => {
		const legacy = { type: "custom", customType: INJECTED_ENTRY, data: { rule: "a", hash: "1" } };
		expect(injectedKeys([legacy])).toEqual(new Set(["a"]));
	});
	it("ignores malformed data", () => {
		expect(injectedKeys([{ type: "custom", customType: INJECTED_ENTRY, data: { rule: 1 } }]).size).toBe(0);
	});
});
