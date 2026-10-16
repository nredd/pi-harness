import { describe, expect, it } from "vitest";
import { ATTRIBUTION, buildCommitMessage, validateSubject } from "../../src/git/commit-message.ts";

describe("validateSubject", () => {
	it.each(["Add shared core", "Pin pi-plan-mode v0.59.2-nredd.2 and add pi-dev-tools v0.1.0", "rtl: Fix the thing"])(
		"accepts %s",
		(s) => {
			expect(validateSubject(s)).toBeUndefined();
		},
	);
	it.each([
		["", /empty/],
		["add thing", /capital/],
		["rtl: fix thing", /capital/],
		["Add thing.", /period/],
		["feat: add thing", /conventional/],
		["Fix(scope)!: thing", /conventional/],
		["Add thing \u2014 now", /dash/],
		["Add thing \u2013 now", /dash/],
		[" Add thing", /whitespace/],
		["Add\nthing", /one line/],
		[`Add ${"x".repeat(70)}`, /max 72/],
	])("rejects %j", (s, re) => {
		expect(validateSubject(s)).toMatch(re);
	});
	it("accepts a subject that is exactly 72 chars", () => {
		expect(validateSubject(`A${"b".repeat(71)}`)).toBeUndefined();
	});
});

describe("buildCommitMessage", () => {
	it("renders subject, why, bullets and the footer", () => {
		expect(buildCommitMessage({ subject: "Do it", why: "Because.", changes: ["- One", "Two"] })).toBe(
			`Do it\n\nBecause.\n\nChanges:\n- One\n- Two\n\n${ATTRIBUTION}\n`,
		);
	});
	it("omits empty sections", () => {
		expect(buildCommitMessage({ subject: "Do it", changes: ["  "] })).toBe(`Do it\n\n${ATTRIBUTION}\n`);
	});
	it("refuses dashes in the body", () => {
		expect(() => buildCommitMessage({ subject: "Do it", why: "a \u2014 b" })).toThrow(/dash/);
	});
});
