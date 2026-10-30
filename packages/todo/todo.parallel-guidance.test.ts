import { readFileSync } from "node:fs";
import { createMockPi } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";
import { registerTodoTool } from "./.test-support/home-fixtures.ts";

/** Pin the instructions actually registered for agents, not a separate policy copy. */
describe("todo default guidance", () => {
	it("tracks parallel owned work accurately without delaying verified completions", () => {
		const { pi, captured } = createMockPi();
		registerTodoTool(pi);
		const guidance = (captured.tools.get("todo")!.promptGuidelines as string[]).join("\n");
		expect(guidance).toContain("EVERY actually started task in_progress BEFORE");
		expect(guidance).toContain("do not leave running work pending");
		expect(guidance).toContain("Multiple parallel tasks may be in_progress");
		expect(guidance).toContain("use owner to identify each worker");
		expect(guidance).toContain("completed IMMEDIATELY");
		expect(guidance).toContain("without delaying individual completions");
		expect(guidance).not.toMatch(/exactly one task in_progress|never batch completions/i);
		expect(guidance).toContain("Each op carries its own evidence/reason");
		expect(guidance).toContain("if any op is invalid nothing changes");
		expect(guidance).toContain("subject and description cannot change");
		expect(guidance).toContain("Complete each with evidence, or defer with a reason");
	});

	it("keeps the shared reference consistent with injected guidance", () => {
		const { pi, captured } = createMockPi();
		registerTodoTool(pi);
		const guidance = (captured.tools.get("todo")!.promptGuidelines as string[]).join("\n");
		const reference = readFileSync(new URL("./docs/tool-schema.md", import.meta.url), "utf8");

		for (const phrase of [
			"started task `in_progress`",
			"parallel work",
			"use `owner`",
			"completed immediately",
			"independently verified outcomes",
			"never delay an individual completion",
			"atomic",
			"text stays locked",
		])
			expect(reference).toContain(phrase);
		expect(reference).not.toMatch(/exactly one task `in_progress`|rather than in batches/i);
		expect(guidance).not.toMatch(/exactly one task in_progress|never batch completions/i);
	});
});
