import { describe, expect, it } from "vitest";
import {
	buildTitlePrompt,
	firstExchange,
	MAX_ASSISTANT_CHARS,
	MAX_USER_CHARS,
	modelCandidates,
	parseModelAliases,
	parseModelRef,
	planModeActive,
	sanitizeTitle,
} from "../../src/titles/logic.ts";

describe("modelCandidates", () => {
	it("puts the configured model first, then the defaults", () => {
		expect(modelCandidates("work/alias-small").map((m) => `${m.provider}/${m.id}`)).toEqual([
			"work/alias-small",
			"anthropic/claude-haiku-5-5",
			"openai-codex/gpt-6-luna",
		]);
	});
	it("deduplicates and uses only defaults when unset", () => {
		expect(modelCandidates("anthropic/claude-haiku-5-5")).toHaveLength(2);
		expect(modelCandidates()).toHaveLength(2);
	});
	it("inserts alias candidates after the pinned default, haiku-5-5 before haiku-4-5", () => {
		const aliases = {
			"claude-haiku-4-5": ["corp/h45"],
			"claude-haiku-5-5": ["corp/h55", "corp/h55b"],
			unrelated: ["x/y"],
		};
		expect(modelCandidates("work/t", aliases).map((m) => `${m.provider}/${m.id}`)).toEqual([
			"work/t",
			"anthropic/claude-haiku-5-5",
			"corp/h55",
			"corp/h55b",
			"corp/h45",
			"openai-codex/gpt-6-luna",
		]);
	});
	it("keeps slashes inside the id and rejects malformed refs", () => {
		expect(parseModelRef("openrouter/a/b")).toEqual({ provider: "openrouter", id: "a/b" });
		expect(parseModelRef("nope")).toBeUndefined();
		expect(parseModelRef("/x")).toBeUndefined();
		expect(parseModelRef("x/")).toBeUndefined();
	});
});

describe("parseModelAliases", () => {
	const manifest = (subagents: unknown, version: unknown = 1) => JSON.stringify({ version, subagents, secret: "s3" });
	const good = {
		modelAliases: { "Claude-Haiku-5-5": [" corp/h55 ", "corp/h55"], bad: ["nope"], "a/b": ["x/y"], none: [] },
	};
	it("returns normalised aliases and drops invalid entries", () => {
		expect(parseModelAliases(manifest(good), 0o600)).toEqual({ "claude-haiku-5-5": ["corp/h55"] });
	});
	it("is empty when aliases are absent", () => {
		expect(parseModelAliases(manifest({}), 0o600)).toEqual({});
		expect(parseModelAliases(JSON.stringify({ version: 1 }), 0o600)).toEqual({});
	});
	it("is empty for malformed manifests", () => {
		expect(parseModelAliases("{nope", 0o600)).toEqual({});
		expect(parseModelAliases("[]", 0o600)).toEqual({});
		expect(parseModelAliases(manifest(good, 2), 0o600)).toEqual({});
		expect(parseModelAliases(manifest([]), 0o600)).toEqual({});
		expect(parseModelAliases(manifest({ modelAliases: [] }), 0o600)).toEqual({});
	});
	it("ignores files readable by group or other", () => {
		expect(parseModelAliases(manifest(good), 0o640)).toEqual({});
		expect(parseModelAliases(manifest(good), 0o604)).toEqual({});
		expect(parseModelAliases(manifest(good), 0o400)).toEqual({ "claude-haiku-5-5": ["corp/h55"] });
	});
});

describe("sanitizeTitle", () => {
	it("strips quotes, labels, markdown and trailing punctuation", () => {
		expect(sanitizeTitle('"Fix the login bug."')).toBe("Fix the login bug");
		expect(sanitizeTitle("Title: **Refactor Auth Flow**")).toBe("Refactor Auth Flow");
	});
	it("takes the first non-empty line", () => {
		expect(sanitizeTitle("\n\nDebug flaky test\nbecause reasons")).toBe("Debug flaky test");
	});
	it("caps at 60 chars on a word boundary", () => {
		const out = sanitizeTitle("word ".repeat(30)) as string;
		expect(out.length).toBeLessThanOrEqual(60);
		expect(out.endsWith("word")).toBe(true);
	});
	it("caps at 6 words but keeps short titles", () => {
		expect(sanitizeTitle("one two three four five six seven eight")).toBe("one two three four five six");
		expect(sanitizeTitle("Refactor")).toBe("Refactor");
		expect(sanitizeTitle("Fix login")).toBe("Fix login");
	});
	it("returns undefined for empty output", () => {
		expect(sanitizeTitle("  \n ")).toBeUndefined();
		expect(sanitizeTitle('""')).toBeUndefined();
	});
});

describe("firstExchange / buildTitlePrompt", () => {
	const entries = [
		{ type: "custom", customType: "x" },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi there" }] } },
		{ type: "message", message: { role: "user", content: "later" } },
	];
	it("finds the first user message and first assistant reply", () => {
		expect(firstExchange(entries)).toEqual({ user: "hello", assistant: "hi there" });
	});
	it("is undefined without a user message", () => {
		expect(firstExchange([{ type: "custom" }])).toBeUndefined();
	});
	it("caps the prompt inputs", () => {
		const prompt = buildTitlePrompt({ user: "u".repeat(5000), assistant: "a".repeat(5000) });
		expect(prompt.match(/u/g)?.length ?? 0).toBeGreaterThanOrEqual(MAX_USER_CHARS);
		expect(prompt).not.toContain("u".repeat(MAX_USER_CHARS + 1));
		expect(prompt).not.toContain("a".repeat(MAX_ASSISTANT_CHARS + 1));
	});
	it("omits the assistant section when there is no reply", () => {
		expect(buildTitlePrompt({ user: "hi", assistant: "" })).not.toContain("Assistant reply");
	});
});

describe("planModeActive", () => {
	const state = (enabled: boolean) => ({ type: "custom", customType: "plan-mode-state", data: { enabled } });
	it("follows the newest plan-mode-state entry", () => {
		expect(planModeActive([state(true)])).toBe(true);
		expect(planModeActive([state(true), state(false)])).toBe(false);
		expect(planModeActive([])).toBe(false);
	});
});
