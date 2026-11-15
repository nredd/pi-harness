/** The tier-only guard shared by `preset`'s resource tests and `subagents`' default-agent test. */
import assert from "node:assert/strict";
import { test } from "vitest";
import { dataModelLeaks, modelLeaks, modelValues, TIER_REF } from "../src/model-guard.ts";

// A clean document the planted text is appended to.
const BASE = '---\nname: x\nmodel: "@frontier"\n---\nRoute every review to the tier above.\n';
const plantIn = (planted: string): string => `${BASE}\n${planted}\n`;
const fence = (lang: string, body: string): string => `\`\`\`${lang}\n${body}\n\`\`\`\n`;

test("structured forms surface a non-tier value without the prose scan", () => {
	for (const planted of [
		'model: "opus"',
		"model: sonnet",
		"model: `opus`",
		'model: "opus fable"',
		'model: ""',
		"model:",
		'{"model": "opus"}',
		"model = 'sonnet'",
		"Model: opus",
		"models: [opus]",
		"subagent_model: opus",
		'models: ["@frontier", "opus"]',
		"models: [@frontier, opus]",
		"model: @frontier,opus",
		"model: @frontier, opus",
		"model: @frontier, o3, @deep",
		"pi --models @review,o3:high -p x",
		"pi --models @review:high,grok-4",
		"pi --models @review:high,o3",
		"model: @frontier,kimi-k2:high",
		"model: @frontier:high",
		'---\nname: x\nmodel: "@review:high"\n---\n',
		'Agent({ subagent_type: "critic", model: "@frontier:high" })',
		"| agent | model |\n|---|---|\n| critic | o3 |",
		"| agent | `Model` |\n| :-- | --: |\n| critic | `@review` |\n| worker | kimi-k2 |",
		"pi --model opus -p x",
		"claude --model sonnet",
		"pi --model=opus",
		"pi --model",
		"subagentModel: opus",
		"modelId: opus",
		"model_id: opus",
		'modelName: "sonnet"',
		'agentModels: { critic: "opus" }',
		'Agent(subagent_type: "critic", model: "opus")',
		'subagent({ type: "critic", model: "x-large" })',
		"#model: o3",
		"<!--model:o3-->",
		"(model: @frontier, o3)",
		"[model: @frontier, o3]",
		"Agent({ model: @frontier, o3 })",
		"model: @frontier, grok-4)",
		"model: @frontier, o3 # hard tasks",
		"Run `/model o3` first.",
		"/model kestrel",
		fence("yaml", 'models:\n  - "@review"\n  - opus'),
		fence("yaml", 'model: "@review"\n# model: o3'),
		fence("jsonc", '{"model": "@review"} // model: o3'),
		fence("json", '{"agentModels": {"critic": "opus"}}'),
		fence("sh", "pi --model opus -p review"),
	]) {
		assert.notDeepEqual(
			modelValues(plantIn(planted)).filter((value) => !TIER_REF.test(value)),
			[],
			planted,
		);
		assert.notDeepEqual(modelLeaks(plantIn(planted)), [], planted);
	}
	assert.deepEqual(modelValues("---\nname: x\nmodel: opus\n---\nbody\n"), ["opus"]);
	assert.deepEqual(modelValues("---\nname: x\nagentModels:\n  critic: [opus, '@review']\n---\n"), ["opus", "@review"]);
	assert.deepEqual(modelLeaks("model: @frontier, o3, @deep"), ["o3"]);
});

test("the best-effort prose scan catches ids written with no key", () => {
	for (const planted of [
		'model: "anthropic/claude-opus-5-5"',
		"Route reviews to openai-codex/gpt-6.1-sol.",
		"Use router/review.",
		"Prefer claude-fable-5-1.",
		"Prefer gpt-6-astra.",
		"Prefer claude-3-5-sonnet.",
		"Prefer google/gemini-3-pro.",
		"Prefer GPT-6.",
		"Prefer Anthropic/Claude-Opus.",
		"Prefer OpenAI/GPT-6.",
		"Prefer gemini-3-pro.",
		"Prefer o4-mini.",
		"Prefer claude-fable.",
		"Prefer Opus.",
		"Prefer Fable.",
		"Prefer Astra.",
		"Prefer gpt5.",
		"Prefer GPT 6.",
		"Prefer Opus5.",
		"Prefer opus_5.",
		"Prefer gemini3pro.",
		"Prefer groq/llama-4.",
		"Prefer ollama/qwen3.",
	])
		assert.notDeepEqual(modelLeaks(plantIn(planted)), [], planted);
	assert.deepEqual(modelLeaks("Prefer gemini-3-pro."), ["gemini-3-pro."]);
});

test("tier references and look-alike prose stay clean", () => {
	for (const clean of [
		'Agent(subagent_type: "critic", model: "@frontier"), {"model": "@review"} and `@deep`.',
		'model: "@frontier"',
		"models: [@review, @deep]",
		"pi --model @review -p x",
		"pi --models @review:high",
		"pi --models @review:high,@deep:low -p x",
		"| agent | model |\n|---|---|\n| critic | @review |\n| worker | `@deep` |",
		"| agent | tools |\n|---|---|\n| critic | read, grep |",
		"The parent's critic, then the worker's model: `@frontier`.",
		"model: @frontier, then the worker reviews.",
		"model: @frontier, then run it",
		"models: @review, @deep",
		fence("yaml", 'models:\n  - "@review"\n  - "@deep"\n# see https://example.com/models'),
		fence("json", '{"agentModels": {"critic": "@frontier"}}'),
		"Astral tooling; Pydantic `BaseModel`; identities/models; Claude Code; C# models.",
	])
		assert.deepEqual(modelLeaks(clean), [], clean);
});

test("parsed data, as subagents' default-agent test passes it", () => {
	assert.deepEqual(dataModelLeaks({ model: "@review", systemPrompt: "Run `pi --model opus`." }), ["opus"]);
	assert.deepEqual(dataModelLeaks({ name: "critic", model: "haiku" }), ["haiku"]);
	assert.deepEqual(dataModelLeaks({ model: "@review:high", tools: ["read"] }), ["@review:high"]);
	assert.deepEqual(dataModelLeaks({ model: "@review", systemPrompt: "Run `pi --models @review:high`." }), []);
});

test("edge shapes: nulls, numbers, undefined, short table rows and a chain cut by the next key", () => {
	assert.deepEqual(dataModelLeaks({ model: null }), [""]);
	assert.deepEqual(dataModelLeaks({ model: 5, retries: 3 }), ["5"]);
	assert.deepEqual(dataModelLeaks({ model: undefined, name: "x" }), []);
	assert.deepEqual(modelValues("| agent | model |\n|---|---|\n| critic |"), [""]);
	assert.deepEqual(modelValues("model: @frontier,other: x"), ["@frontier"]);
});

test("known limits stay documented", () => {
	// Keyless ids outside `MODEL_ID_PATTERNS`, and syntax pi does not have (no `-m` flag) or use.
	for (const missed of ["Prefer o3.", "Prefer grok-4.", "pi -m o3", 'cfg["model"] = "o3"'])
		assert.deepEqual(modelLeaks(missed), [], missed);
});
