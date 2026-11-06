// Strict static checks on the packaged resources: agents, skills, themes, settings defaults,
// declared external dependencies, and the host-import surface of the footer code.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import Schema from "typebox/schema";
import { test } from "vitest";
import { dataModelLeaks, modelLeaks, modelValues, TIER_REF } from "./model-guard.ts";
import { frontmatterOf, type Json, manifest, packedFiles, pkgRoot, readJson, readText, walk } from "./support.ts";

const AGENTS = [
	"architect",
	"code-reviewer",
	"critic",
	"debugger",
	"general-purpose",
	"principal-investigator",
	"researcher",
	"verifier",
];
const SKILLS = ["code-review", "coding-like-redd", "get-it-merged", "ship-issue"];
const THEMES = ["belafonte-day", "tokyonight-storm"];
const AGENT_KEYS = new Set([
	"name",
	"description",
	"tools",
	"extensions",
	"exclude_extensions",
	"disallowed_tools",
	"skills",
	"thinking",
	"max_turns",
	"prompt_mode",
	"allowed_subagents",
]);
const SHORT_NAME = /^[a-z0-9][a-z0-9-]*$/;
const SELECTOR = /^ext:([a-z0-9][a-z0-9-]*)(?:\/[a-z0-9_]+)?$/;

interface Settings extends Json {
	enabledModels: string[];
	defaultProvider: string;
	defaultModel: string;
}

const csv = (value: unknown): string[] =>
	String(value)
		.split(",")
		.map((v) => v.trim())
		.filter(Boolean);
const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : csv(value));
const piSchema = (name: string): Json =>
	JSON.parse(readFileSync(join(getPackageDir(), "schemas", `${name}.schema.json`), "utf8"));
/** Unwrap a lookup that the test has already established must succeed. */
function must<T>(value: T | undefined): T {
	assert.notEqual(value, undefined);
	return value as T;
}
const external = () => manifest().piPreset.externalResources;

test("exactly the eight agents ship, each a well-formed definition", () => {
	assert.deepEqual(
		walk("agents").map((p) => p.replace(/^agents\/|\.md$/g, "")),
		AGENTS,
	);
	for (const agent of AGENTS) {
		const { frontmatter, body } = frontmatterOf(`agents/${agent}.md`);
		assert.equal(frontmatter.name, agent);
		assert.ok(String(frontmatter.description ?? "").length > 0, `${agent}: description`);
		assert.ok(body.trim().length > 0, `${agent}: body`);
		for (const key of Object.keys(frontmatter)) assert.ok(AGENT_KEYS.has(key), `${agent}: unknown key '${key}'`);
		assert.ok(["replace", "append"].includes(String(frontmatter.prompt_mode)), `${agent}: prompt_mode`);
	}
});

test("shell-less agents disclose their limits in the first sentence and stop on blocked commands", () => {
	for (const agent of AGENTS) {
		const { frontmatter, body } = frontmatterOf(`agents/${agent}.md`);
		const description = String(frontmatter.description);
		const firstSentence = description.split(/[.!?](?:\s|$)/)[0] ?? "";
		if (["architect", "code-reviewer", "critic", "principal-investigator", "researcher"].includes(agent)) {
			assert.ok(firstSentence.includes("no shell/ssh: cannot run commands"), agent);
			assert.ok(body.includes("FIRST turn, before any tool calls"), agent);
			assert.ok(body.includes("stop rather than spending a run on partial substitutes"), agent);
		} else {
			assert.ok(!description.includes("no shell/ssh"), agent);
		}
	}
	for (const agent of ["critic", "principal-investigator"]) {
		assert.ok(
			String(frontmatterOf(`agents/${agent}.md`).frontmatter.description).includes(
				"except existing tests via py_test/cargo_test",
			),
			agent,
		);
	}
});

test("principal-investigator is a read-only, unpinned judge with a fixed output template", () => {
	const { frontmatter, body } = frontmatterOf("agents/principal-investigator.md");
	assert.deepEqual(csv(frontmatter.tools), [
		"read",
		"grep",
		"find",
		"ext:pi-dev-tools/git_diff",
		"ext:pi-dev-tools/git_show",
		"ext:pi-dev-tools/git_log",
		"ext:pi-dev-tools/git_status",
		"ext:pi-dev-tools/py_test",
		"ext:pi-dev-tools/cargo_test",
		"ext:pi-web-access",
	]);
	assert.deepEqual(list(frontmatter.extensions), ["pi-dev-tools", "pi-web-access"]);
	for (const key of ["model", "thinking", "allowed_subagents", "disallowed_tools"]) {
		assert.ok(!(key in frontmatter), `principal-investigator: no ${key}`);
	}
	assert.ok(!csv(frontmatter.tools).some((t) => /bash|edit|write|ssh/.test(t)));
	assert.match(String(frontmatter.description), /^Read-only principal investigator, no shell\/ssh/);
	assert.ok(String(frontmatter.description).includes("at most 3 acceptance items"));
	for (const part of ["Reviewed:", "Not checked:", "Reproduced:", "Satisfied? YES|NO", "Factual concerns:"]) {
		assert.ok(body.includes(part), part);
	}
	assert.ok(body.includes("caller-supplied"));
});

test("agents carry no model or logical-role references (strict roles are not implemented yet)", () => {
	for (const file of [...walk("agents"), ...walk("skills")]) {
		const text = readText(file);
		assert.ok(!/^model\s*:/m.test(text), `${file}: model: key`);
		assert.ok(!/\brole\s*:/i.test(text), `${file}: role: reference`);
	}
});

/** A shipped skill to plant cases into, so each case is checked against real surrounding text. */
const plantIn = (planted: string): string => `${readText("skills/ship-issue/SKILL.md")}\n${planted}\n`;
const fence = (lang: string, body: string): string => `\`\`\`${lang}\n${body}\n\`\`\`\n`;

test("skills and agents name tiers, never models", () => {
	for (const file of [...walk("agents"), ...walk("skills")]) assert.deepEqual(modelLeaks(readText(file)), [], file);
	const ship = readText("skills/ship-issue/SKILL.md");
	assert.deepEqual(modelValues(ship), ["@frontier"]);
	assert.match(ship, /If either route\s+is quota-parked, wait; do not silently substitute a model or another tier\./);
});

test("model guard: structured forms surface a non-tier value without the prose scan", () => {
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

test("model guard: the best-effort prose scan catches ids written with no key", () => {
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

test("model guard: tier references and look-alike prose stay clean", () => {
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

test("model guard: parsed data, as pi-subagents' default-agent test passes it", () => {
	assert.deepEqual(dataModelLeaks({ model: "@review", systemPrompt: "Run `pi --model opus`." }), ["opus"]);
	assert.deepEqual(dataModelLeaks({ name: "critic", model: "haiku" }), ["haiku"]);
	assert.deepEqual(dataModelLeaks({ model: "@review:high", tools: ["read"] }), ["@review:high"]);
	assert.deepEqual(dataModelLeaks({ model: "@review", systemPrompt: "Run `pi --models @review:high`." }), []);
});

test("model guard: known limits stay documented", () => {
	// Keyless ids outside `MODEL_ID_PATTERNS`, and syntax pi does not have (no `-m` flag) or use.
	for (const missed of ["Prefer o3.", "Prefer grok-4.", "pi -m o3", 'cfg["model"] = "o3"'])
		assert.deepEqual(modelLeaks(missed), [], missed);
});

test("agent extension selectors use short names, never the scoped form", () => {
	for (const agent of AGENTS) {
		const { frontmatter } = frontmatterOf(`agents/${agent}.md`);
		for (const tool of list(frontmatter.tools ?? [])) {
			if (tool.startsWith("ext:")) assert.match(tool, SELECTOR, `${agent}: selector '${tool}'`);
		}
		const exts = frontmatter.extensions;
		if (typeof exts !== "boolean" && exts !== undefined) {
			for (const name of list(exts)) assert.match(name, SHORT_NAME, `${agent}: extensions entry '${name}'`);
		}
		for (const name of list(frontmatter.exclude_extensions ?? [])) assert.match(name, SHORT_NAME);
		assert.ok(!readText(`agents/${agent}.md`).includes("ext:@"), `${agent}: scoped selector`);
	}
});

test("no preset agent pins thinking, so callers and pi defaults decide", () => {
	for (const agent of AGENTS) {
		const { frontmatter } = frontmatterOf(`agents/${agent}.md`);
		assert.ok(!("thinking" in frontmatter), `${agent}: pins thinking`);
	}
});

test("every selector's extension is a declared external extension and the declaration matches usage", () => {
	const declared = new Map(external().extensions.map((e) => [e.name, e]));
	const used = new Map();
	for (const agent of AGENTS) {
		const { frontmatter } = frontmatterOf(`agents/${agent}.md`);
		const names = new Set();
		for (const tool of list(frontmatter.tools ?? [])) {
			const hit = SELECTOR.exec(tool);
			if (hit) names.add(hit[1]);
		}
		if (typeof frontmatter.extensions !== "boolean" && frontmatter.extensions !== undefined) {
			for (const name of list(frontmatter.extensions)) names.add(name);
		}
		for (const name of names) used.set(name, [...(used.get(name) ?? []), `agents/${agent}.md`]);
	}
	assert.deepEqual([...used.keys()].sort(), [...declared.keys()].sort());
	for (const [name, files] of used) {
		const entry = must(declared.get(name));
		assert.deepEqual([...entry.requiredBy].sort(), files.sort(), `requiredBy for ${name}`);
		assert.equal(entry.selectorForm, "short-name");
		assert.ok(!entry.package.startsWith("@") || entry.package.endsWith(`/${name}`), `${name}: package`);
	}
});

test("skills an agent preloads are owned here or declared external, and external ones are not vendored", () => {
	const ownedNames = new Set(SKILLS);
	const declared = new Map(external().skills.map((s) => [s.name, s]));
	const used = new Map();
	for (const agent of AGENTS) {
		const { frontmatter } = frontmatterOf(`agents/${agent}.md`);
		const skills = frontmatter.skills;
		if (typeof skills === "boolean" || skills === undefined) continue;
		for (const name of list(skills)) {
			if (ownedNames.has(name)) continue;
			used.set(name, [...(used.get(name) ?? []), `agents/${agent}.md`]);
		}
	}
	assert.deepEqual([...used.keys()].sort(), [...declared.keys()].sort());
	for (const [name, files] of used) {
		const entry = must(declared.get(name));
		assert.deepEqual([...entry.requiredBy].sort(), files.sort());
		assert.equal(entry.license, "MIT");
		assert.match(entry.revision, /^[0-9a-f]{40}$/);
		assert.match(entry.source, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
		assert.ok(!SKILLS.includes(name));
		assert.ok(!walk("skills").some((p) => p.split("/")[1] === name), `${name} is vendored`);
	}
});

test("exactly the four owned skills ship, each a single valid SKILL.md", () => {
	assert.deepEqual(
		walk("skills").map((p) => p.split("/").slice(1).join("/")),
		SKILLS.map((s) => `${s}/SKILL.md`),
	);
	for (const skill of SKILLS) {
		const { frontmatter, body } = frontmatterOf(`skills/${skill}/SKILL.md`);
		assert.equal(frontmatter.name, skill);
		assert.match(frontmatter.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
		assert.ok(frontmatter.name.length <= 64);
		const description = String(frontmatter.description ?? "");
		assert.ok(description.length > 0 && description.length <= 1024, `${skill}: description length`);
		assert.ok(body.trim().length > 0);
	}
});

const section = (text: string, heading: string): string => {
	const start = text.indexOf(`## ${heading}`);
	if (start < 0) return "";
	const next = text.indexOf("\n## ", start + 3);
	return text.slice(start, next < 0 ? undefined : next);
};

const missing = (clauses: Record<string, boolean>): string[] =>
	Object.entries(clauses)
		.filter(([, held]) => !held)
		.map(([name]) => name);

/** Names of the merge-step clauses the parent driver no longer carries. */
const missingDriveClauses = (policy: string): string[] => {
	const drive = section(policy, "4. Merge and advance (parent)");
	return missing({
		"pinned auto-merge": /gh pr merge <N> --auto --<method> --match-head-commit <full-sha>/.test(drive),
		"pinned explicit merge when unprotected":
			/Backend not proven protected: keep auto-merge OFF[^\n]*gh pr merge <N> --<method> --match-head-commit <full-sha>/.test(
				drive,
			),
		"uncertain protection is unprotected":
			/A 403, plan-gated error, unknown, or uncertain bypass eligibility is NOT protected/.test(drive),
		"caller cannot bypass": drive.includes("the merging caller cannot bypass them"),
		"no --admin": drive.includes("Never use `--admin` or any bypass"),
		"native monitor": drive.includes("Start `monitor_start` (discover via `search_tools` if deferred)"),
		"next PR loop": drive.includes("return to step 3 for the next unblocked PR"),
		"whole list": drive.includes("every requested PR is merged"),
		"no parent handoff": !/hand(?:s)? (?:the|it to the) parent/i.test(drive),
		"parent driver": /PARENT driver[^\n]*never hands the merge to "the parent": it IS the parent/.test(policy),
		"worker has no merge authority": /DELEGATED worker[^\n]*no merge authority/.test(policy),
	});
};

/** Names of the admission clauses that gate merge on critics without fabricated evidence. */
const missingCriticGate = (policy: string): string[] => {
	const bullets = section(policy, "3. Admit one candidate")
		.split("\n")
		.filter((line) => line.startsWith("- "));
	const checked = bullets.filter((line) => line.includes("`Checked:`"));
	return missing({
		"worker or permitted critic receipt first": /^- When a worker or permitted critic receipt is present/.test(
			bullets[0] ?? "",
		),
		"parent final critic gate last": /^- Gate: run the parent's own final critic on the exact HEAD[^\n]*mandatory/.test(
			bullets.at(-1) ?? "",
		),
		"checked scoped to axes": checked.every((line) => /Standards and Spec axes|for the critic/.test(line)),
		"no synthesized critic evidence": checked.some((line) =>
			line.includes("Never synthesize `Checked:` evidence for the critic"),
		),
	});
};

/** A forced model is any `model:` value that is not a tier reference. */
const assertNoForcedModel = (text: string): void =>
	assert.deepEqual(
		modelValues(text).filter((value) => !TIER_REF.test(value)),
		[],
	);

/** Replaces every occurrence of a clause that must exist, so a reworded skill fails as fixture drift. */
const mutate = (text: string, from: string, to: string): string => {
	assert.ok(text.includes(from), `fixture drift: ${from}`);
	return text.split(from).join(to);
};

/** Every documented `gh pr merge` command: inline code spans plus fenced lines with `\` continuations joined. */
const mergeCommands = (text: string): string[] => {
	const fenced: string[] = [];
	const prose = text.replace(
		/^[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm,
		(_match, _fence, body: string) => {
			fenced.push(...body.replace(/[ \t]*\\\n[ \t]*/g, " ").split("\n"));
			return "";
		},
	);
	return [
		...[...prose.matchAll(/`gh pr merge [^`]*`/g)].map(([span]) => span),
		...fenced.filter((line) => /\bgh pr merge\b/.test(line)),
	];
};

/** Merge commands that are not head-pinned or that bypass protection. */
const unsafeMerges = (commands: string[]): string[] =>
	commands.filter(
		(command) =>
			!command.includes("--disable-auto") &&
			(!command.includes("--match-head-commit <full-sha>") || command.includes("--admin")),
	);

test("shipping skills pin every merge to the head, never bypass protection, and force no model", () => {
	let merges = 0;
	for (const skill of ["code-review", "ship-issue", "get-it-merged"]) {
		const text = readText(`skills/${skill}/SKILL.md`);
		assertNoForcedModel(text);
		const commands = mergeCommands(text);
		merges += commands.length;
		assert.deepEqual(unsafeMerges(commands), [], skill);
	}
	assert.ok(merges >= 2, "no merge commands scanned");
	const pinned = "gh pr merge 1 --auto --squash --match-head-commit <full-sha>";
	const cases: [string, string[]][] = [
		[`Run \`${pinned}\`.`, []],
		["Run `gh pr merge 1 --auto --squash`.", ["`gh pr merge 1 --auto --squash`"]],
		[
			"Run `gh pr merge 1 --squash\n--match-head-commit <full-sha> --admin`.",
			["`gh pr merge 1 --squash\n--match-head-commit <full-sha> --admin`"],
		],
		[`\`\`\`sh\n${pinned}\n\`\`\`\n`, []],
		["```sh\ngh pr merge 1 --squash\n```\n", ["gh pr merge 1 --squash"]],
		[
			"~~~\ngh pr merge 1 --squash \\\n  --match-head-commit <full-sha> --admin\n~~~\n",
			["gh pr merge 1 --squash --match-head-commit <full-sha> --admin"],
		],
		["```sh\ngh pr merge --disable-auto 1\n```\n", []],
		["- Merge:\n  ```sh\n  gh pr merge 1 --squash\n  ```\n", ["  gh pr merge 1 --squash"]],
	];
	for (const [text, expected] of cases) assert.deepEqual(unsafeMerges(mergeCommands(text)), expected, text);
	for (const override of ["model: opus", 'model: "sonnet"']) assert.throws(() => assertNoForcedModel(override));
	assertNoForcedModel('model: "@frontier"');
});

test("code-reviewer ships the receipt skeleton the parser accepts, including the no-spec branch", () => {
	const reviewer = readText("agents/code-reviewer.md");
	assert.match(reviewer, /^Axis: <Standards\|Spec>\nReviewed HEAD: <full-40-character-sha>\nChecked:\n- /m);
	assert.match(reviewer, /\nFindings:\n\[hard\|judgement\]/);
	assert.doesNotMatch(reviewer, /^Findings: \S/m);
	assert.match(reviewer, /`Checked:` \/ `- No spec available\.`/);
});

test("get-it-merged gates admission on the parent critic; negative controls", () => {
	const merge = readText("skills/get-it-merged/SKILL.md");
	assert.deepEqual(missingCriticGate(merge), []);
	assert.deepEqual(
		missingCriticGate(mutate(merge, "- When a worker or permitted critic receipt", "- If a critic receipt")),
		["worker or permitted critic receipt first"],
	);
	assert.deepEqual(missingCriticGate(mutate(merge, "It is mandatory even when", "It is optional when")), [
		"parent final critic gate last",
	]);
	assert.deepEqual(
		missingCriticGate(
			mutate(merge, "Confirm the Standards and Spec axes have `Checked:`", "Confirm all reviews have `Checked:`"),
		),
		["checked scoped to axes"],
	);
	assert.deepEqual(missingCriticGate(mutate(merge, "Never synthesize `Checked:` evidence for the critic", "Done")), [
		"no synthesized critic evidence",
	]);
});

test("get-it-merged parent drives the whole list; negative controls", () => {
	const merge = readText("skills/get-it-merged/SKILL.md");
	assert.deepEqual(missingDriveClauses(merge), []);
	const drive = section(merge, "4. Merge and advance (parent)");
	const cases: [string, string, string[]][] = [
		["--auto --<method> --match-head-commit <full-sha>", "--auto --<method>", ["pinned auto-merge"]],
		[
			"merge explicitly with `gh pr merge <N> --<method> --match-head-commit <full-sha>`",
			"merge explicitly",
			["pinned explicit merge when unprotected"],
		],
		[
			"A 403, plan-gated error, unknown, or uncertain bypass eligibility is NOT protected",
			"A 403 is fine",
			["uncertain protection is unprotected"],
		],
		["the merging caller cannot bypass them", "the merging caller can bypass them", ["caller cannot bypass"]],
		["Never use `--admin` or any bypass", "", ["no --admin"]],
		["monitor_start", "poll", ["native monitor"]],
		["Start `monitor_start` (discover via `search_tools` if deferred)", "Start `monitor_start`", ["native monitor"]],
		["return to step 3 for the next unblocked PR", "stop", ["next PR loop"]],
		["every requested PR is merged", "one PR is merged", ["whole list"]],
		[drive, `${drive}\n- Hand the parent the PR URL and stop.`, ["no parent handoff"]],
		["it IS the parent", "it waits", ["parent driver"]],
		["no merge authority", "merge authority", ["worker has no merge authority"]],
	];
	for (const [from, to, expected] of cases) {
		assert.deepEqual(missingDriveClauses(mutate(merge, from, to)), expected, to);
	}
});

test("themes validate against Pi's theme schema and carry no extra metadata", () => {
	const check = Schema.Compile(piSchema("theme"));
	const allowedTop = new Set(["$schema", "name", "appearance", "vars", "colors", "export"]);
	assert.deepEqual(
		walk("themes").map((p) => p.replace(/^themes\/|\.json$/g, "")),
		THEMES,
	);
	for (const name of THEMES) {
		const theme = readJson(`themes/${name}.json`);
		assert.equal(theme.name, name);
		assert.ok(check.Check(theme), `${name}: ${JSON.stringify([...check.Errors(theme)].slice(0, 2))}`);
		for (const key of Object.keys(theme)) assert.ok(allowedTop.has(key), `${name}: top-level '${key}'`);
		assert.equal(theme.$schema, "https://pi.dev/schemas/theme.schema.json");
	}
	assert.ok(
		!check.Check({ ...readJson<Json>("themes/belafonte-day.json"), license: "CC-BY-SA-4.0" }),
		"schema must reject metadata",
	);
});

test("NOTICE.md classifies every theme color as upstream or local, with the verified upstream sets", () => {
	const UPSTREAM: Record<string, string[]> = {
		"tokyonight-storm": [
			"#24283b",
			"#1f2335",
			"#1b1e2d",
			"#292e42",
			"#c0caf5",
			"#a9b1d6",
			"#565f89",
			"#545c7e",
			"#3b4261",
			"#7aa2f7",
			"#7dcfff",
			"#9ece6a",
			"#bb9af7",
			"#ff007c",
			"#9d7cd8",
			"#ff9e64",
			"#f7768e",
			"#e0af68",
		],
		"belafonte-day": ["#d5ccba", "#45373c", "#5e5252", "#20111b", "#426a79", "#be100e", "#97522c", "#968c83"],
	};
	const notice = readText("NOTICE.md");
	for (const name of THEMES) {
		const section = notice.split(/^## /m).find((s) => s.startsWith(`themes/${name}.json`));
		assert.ok(section, `${name}: NOTICE section`);
		const hexes = (label: string): string[] => {
			const line = section.split("\n").find((l) => l.startsWith(`- ${label}:`));
			assert.ok(line, `${name}: ${label} line`);
			return [...line.matchAll(/`(#[0-9a-f]{6})`/g)].map((m) => must(m[1]));
		};
		const upstream = hexes("Upstream");
		const local = hexes("Local");
		assert.deepEqual([...upstream].sort(), [...must(UPSTREAM[name])].sort(), `${name}: verified upstream set`);
		assert.deepEqual(
			upstream.filter((h) => local.includes(h)),
			[],
			`${name}: overlap`,
		);
		const used = new Set(
			readText(`themes/${name}.json`)
				.match(/#[0-9a-fA-F]{6}\b/g)
				?.map((h) => h.toLowerCase()),
		);
		assert.deepEqual([...used].sort(), [...upstream, ...local].sort(), `${name}: colors in file vs NOTICE`);
		assert.ok(/MODIFIED/.test(section), `${name}: change notice`);
	}
});

test("license texts are the pinned upstream copies and the root license is not claimed for the themes", () => {
	const sha = (rel: string): string =>
		createHash("sha256")
			.update(readFileSync(join(pkgRoot, rel)))
			.digest("hex");
	assert.equal(
		sha("licenses/Apache-2.0-tokyonight.nvim.txt"),
		"c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
	);
	assert.equal(
		sha("licenses/MIT-enkia-tokyo-night-vscode-theme.txt"),
		"e3f5d0d772cda0f4f67405696f15a0f335460a2b3944eff40f00675aadacb31b",
	);
	assert.equal(sha("licenses/CC-BY-SA-4.0.txt"), "28a9529c7d0bb4dc51f4bf5c116a3d16ef247a052f7591466768ddf563fd1cf5");
	assert.match(readText("licenses/MIT-enkia-tokyo-night-vscode-theme.txt"), /Copyright \(c\) 2018-present Enkia/);
	assert.match(readText("licenses/Apache-2.0-tokyonight.nvim.txt"), /Apache License\s+Version 2\.0/);
	assert.match(readText("licenses/CC-BY-SA-4.0.txt"), /^Attribution-ShareAlike 4\.0 International/);
	const notice = readText("NOTICE.md");
	for (const needle of [
		"cdc07ac78467a233fd62c493de29a17e0cf2b2b6",
		"7c0f11eaef322f293621ca7befe462214b7ea468",
		"1a9279f6275656f165243e5a7289c45c296a4e15",
		"Jan T. Sott",
		"Apache-2.0",
		"CC-BY-SA-4.0",
		"does **not** relicense the theme files",
	]) {
		assert.ok(notice.includes(needle), needle);
	}
	assert.equal(manifest().license, "MIT AND Apache-2.0 AND CC-BY-SA-4.0");
	assert.match(readText("LICENSE"), /^MIT License/);
	for (const rel of ["README.md"]) assert.ok(readText(rel).includes("does **not** cover the"), rel);
});

test("settings defaults are a public-safe subset of keys Pi knows", () => {
	const settings = readJson<Settings>("settings/personal-defaults.json");
	const schema = piSchema("settings");
	assert.ok(
		Schema.Compile(schema).Check(settings),
		JSON.stringify([...Schema.Compile(schema).Errors(settings)].slice(0, 2)),
	);
	const ALLOWED = [
		"$schema",
		"defaultProvider",
		"defaultModel",
		"defaultThinkingLevel",
		"theme",
		"tuiMode",
		"fullscreenExitOutput",
		"enableInstallTelemetry",
		"hideThinkingBlock",
		"outputPad",
		"quietStartup",
		"compaction",
		"terminal",
		"warnings",
		"enabledModels",
	];
	assert.deepEqual(Object.keys(settings).sort(), [...ALLOWED].sort());
	for (const key of ALLOWED.filter((k) => k !== "$schema"))
		assert.ok(key in (schema.properties as Json), `Pi knows '${key}'`);
	for (const forbidden of [
		"packages",
		"externalEditor",
		"shellPath",
		"httpProxy",
		"npmCommand",
		"sessionDir",
		"extensions",
		"skills",
		"themes",
		"prompts",
		"trackingId",
		"deviceId",
	]) {
		assert.ok(!(forbidden in settings), forbidden);
	}
	assert.equal(settings.enableInstallTelemetry, false);
	assert.equal(settings.theme, "belafonte-day/tokyonight-storm");
	for (const model of settings.enabledModels) {
		assert.match(model, /^[a-z][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/);
		assert.ok(!model.startsWith("router/"), "router models belong to the personal router profile");
	}
	assert.ok(settings.enabledModels.includes(`${settings.defaultProvider}/${settings.defaultModel}`));
	assert.deepEqual(JSON.stringify(settings).match(/https?:\/\/[^"]+/g), [
		"https://pi.dev/schemas/settings.schema.json",
	]);
});

test("footer code imports only node built-ins, declared peers, and its own siblings", () => {
	const allowed = (spec: string): boolean =>
		spec.startsWith("node:") ||
		spec === "@earendil-works/pi-coding-agent" ||
		spec === "@earendil-works/pi-tui" ||
		/^\.\.?\/(lib\/)?footer-(cache|quota)\.ts$/.test(spec) ||
		/^\.\.\/lib\/footer-(cache|quota)\.ts$/.test(spec);
	for (const file of ["extensions/expanded-footer.ts", "lib/footer-cache.ts", "lib/footer-quota.ts"]) {
		const specs = [...readText(file).matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gm)].map((m) =>
			must(m[1]),
		);
		for (const spec of specs) assert.ok(allowed(spec), `${file}: import '${spec}'`);
		assert.ok(
			!/\bfetch\s*\(|node:(http|https|net|dns)|XMLHttpRequest|process\.env\.[A-Z_]*(KEY|TOKEN|SECRET)/.test(
				readText(file),
			),
			`${file}: network or credential access`,
		);
	}
	const lib = ["lib/footer-cache.ts", "lib/footer-quota.ts"].map(readText).join("\n");
	assert.ok(!lib.includes("@earendil-works"), "lib/ stays free of host imports");
	assert.deepEqual(readText("extensions/expanded-footer.ts").match(/from "\.\.\/lib\/footer-(?:cache|quota)\.ts"/g), [
		'from "../lib/footer-cache.ts"',
		'from "../lib/footer-quota.ts"',
	]);
	assert.equal(packedFiles().filter((f) => f.startsWith("lib/")).length, 2);
});

test("code-review binds both axes to one immutable whole-PR range", () => {
	const review = readText("skills/code-review/SKILL.md");
	assert.match(review, /git rev-parse HEAD/);
	assert.match(review, /git diff <reviewed-base>\.\.\.<reviewed-head>/);
	const promptBinding =
		/The full original reviewed-base SHA, full reviewed HEAD SHA, and immutable whole-PR diff command/g;
	assert.equal(review.match(promptBinding)?.length, 2, "both axis prompts carry the immutable range");
});

test("single-issue parents retain terminal ownership", () => {
	const ship = readText("skills/ship-issue/SKILL.md");
	const retainsOwner = (policy: string) => {
		const handoff = section(policy, "9. Handoff and cleanup");
		return (
			/Parent completion: continue until this PR is `MERGED`/.test(handoff) &&
			/genuine external blocker has a named owner and an armed continuation monitor/.test(handoff)
		);
	};
	assert.ok(retainsOwner(ship));
	assert.ok(!retainsOwner(ship.replace(/^- Parent completion:[^\n]*\n/m, "")));
});

type ShippingSkills = { review: string; ship: string; merge: string };

const shippingSkills = (): ShippingSkills => ({
	review: readText("skills/code-review/SKILL.md"),
	ship: readText("skills/ship-issue/SKILL.md"),
	merge: readText("skills/get-it-merged/SKILL.md"),
});

/** Auto-merge appears only in the handoff, after the review round, never in an earlier step. */
const armsAfterReviews = (ship: string): boolean => {
	const reviews = ship.indexOf("## 7. Review round");
	const handoff = ship.indexOf("## 9. Handoff and cleanup");
	return reviews >= 0 && reviews < handoff && !/auto-merge|--auto\b/i.test(ship.slice(0, handoff));
};

/** A reviewer-model exception for a user choice, in either clause order. */
const MODEL_CARVE_OUT =
	/\bmodel\b[^.\n]*\b(?:unless|except)\b[^.\n]*\buser\b|\b(?:unless|except)\b[^.\n]*\buser\b[^.\n]*\bmodel\b/i;

/** Names of the #269 review, train and release clauses the shipping skills no longer carry. */
const missingReviewPolicy = ({ review, ship, merge }: ShippingSkills): string[] =>
	missing({
		"reviewers spawn without a model override": review.includes("and no `model` override."),
		"no user-named model carve-out": ![review, ship, merge].some((text) => MODEL_CARVE_OUT.test(text)),
		"non-PR fixed point is the base": review.includes(
			"For a non-PR review, use the resolved fixed point as `<reviewed-base>`",
		),
		"merge-base preserved across HEAD changes":
			review.includes("record its full SHA as `<reviewed-base>`, and preserve it across every later HEAD change") &&
			review.includes("restart from this step with the preserved `<reviewed-base>`"),
		"corrective delta supplemental in code-review": review.includes(
			"A corrective-delta review is supplemental only and never replaces either required whole-PR axis",
		),
		"corrective delta supplemental in get-it-merged": merge.includes("corrective-delta reviews are supplemental only"),
		"delegated worker keeps auto-merge off": ship.includes(
			"Delegated worker: keep auto-merge off, do not merge or arm it",
		),
		"ship-issue merges as a one-PR train": ship.includes("follow `/skill:get-it-merged` steps 3-4 as a one-PR train"),
		"ship-issue needs no base-advance rebase": ship.includes(
			"Do not require a rebase merely because the base advanced",
		),
		"get-it-merged needs no latest-main rebase": merge.includes(
			"Do not require a latest-main rebase solely because the base advanced",
		),
		"frozen combined gate before publish/deploy": /frozen combined gate immediately before\s+publish\/deploy/.test(
			merge,
		),
		"parent-only native monitors": merge.includes(
			"Parent only: use native session-kit monitors (`monitor_start`, discover via `search_tools` if deferred)",
		),
		"no EnterWorktree tool": ship.includes("Do NOT use the `EnterWorktree` tool"),
		"no ambiguous /code-review command":
			ship.includes("use `/skill:code-review` for the separate Standards") &&
			ship.includes("do not use the ambiguous `/code-review` workflow command"),
		"whole-job reruns only": merge.includes(
			"rerun the whole permitted job, never a selected failed-test subset or an until-green loop",
		),
		"early rollups are not terminal CI": merge.includes(
			"Early check rollups may contain only classification jobs and are not terminal workflow evidence",
		),
		"ship-issue arms auto-merge only after reviews": armsAfterReviews(ship),
	});

test("shipping skills keep the #269 review, train and release clauses; negative controls", () => {
	const skills = shippingSkills();
	assert.deepEqual(missingReviewPolicy(skills), []);
	const cases: [keyof ShippingSkills, string, string, string[]][] = [
		[
			"review",
			"and no `model` override.",
			"and no `model` unless the user named one.",
			["reviewers spawn without a model override", "no user-named model carve-out"],
		],
		[
			"merge",
			"without model overrides",
			"without model overrides unless the user named one",
			["no user-named model carve-out"],
		],
		[
			"review",
			"For a non-PR review, use the resolved fixed point",
			"For a non-PR review, use HEAD~1",
			["non-PR fixed point is the base"],
		],
		[
			"review",
			", and preserve it across every later HEAD change",
			", and recompute it after every HEAD change",
			["merge-base preserved across HEAD changes"],
		],
		[
			"review",
			"with the preserved `<reviewed-base>`",
			"with a fresh merge-base",
			["merge-base preserved across HEAD changes"],
		],
		[
			"review",
			"A corrective-delta review is supplemental only",
			"A corrective-delta review replaces the axes",
			["corrective delta supplemental in code-review"],
		],
		[
			"merge",
			"corrective-delta reviews are supplemental only",
			"corrective-delta reviews replace both axes",
			["corrective delta supplemental in get-it-merged"],
		],
		[
			"ship",
			"Delegated worker: keep auto-merge off",
			"Delegated worker: arm auto-merge",
			["delegated worker keeps auto-merge off"],
		],
		["ship", "as a one-PR train", "as needed", ["ship-issue merges as a one-PR train"]],
		["ship", "Do not require a rebase merely", "Always rebase", ["ship-issue needs no base-advance rebase"]],
		[
			"merge",
			"Do not require a latest-main rebase",
			"Require a latest-main rebase",
			["get-it-merged needs no latest-main rebase"],
		],
		[
			"merge",
			"frozen combined gate immediately before",
			"usual gate after",
			["frozen combined gate before publish/deploy"],
		],
		["merge", "Parent only: use native session-kit monitors", "Use shell sleep loops", ["parent-only native monitors"]],
		["merge", ", discover via `search_tools` if deferred)", ")", ["parent-only native monitors"]],
		[
			"review",
			"and no `model` override.",
			"and no `model` override. Except when the user picks one, pass that model.",
			["no user-named model carve-out"],
		],
		["ship", "Do NOT use the `EnterWorktree` tool", "Use the `EnterWorktree` tool", ["no EnterWorktree tool"]],
		[
			"ship",
			"do not use the ambiguous `/code-review` workflow command",
			"run the `/code-review` workflow command",
			["no ambiguous /code-review command"],
		],
		["merge", "rerun the whole permitted job, never", "rerun only the failed tests, never", ["whole-job reruns only"]],
		[
			"merge",
			"and are not terminal workflow evidence",
			"and are terminal workflow evidence",
			["early rollups are not terminal CI"],
		],
		[
			"ship",
			"## 8. Open the PR",
			"- Arm auto-merge: `gh pr merge <N> --auto --squash --match-head-commit <full-sha>`\n\n## 8. Open the PR",
			["ship-issue arms auto-merge only after reviews"],
		],
		[
			"ship",
			"## 7. Review round -- exact final HEAD",
			"## 7. Arm auto-merge, then review the exact final HEAD",
			["ship-issue arms auto-merge only after reviews"],
		],
	];
	for (const [skill, from, to, expected] of cases) {
		const mutated = { ...skills, [skill]: mutate(skills[skill], from, to) };
		assert.deepEqual(missingReviewPolicy(mutated), expected, to);
	}
});

/** Names of the caller clauses that keep restricted workers and verified no-spec reviews on both axes. */
const missingCallerClauses = (ship: string, review: string): string[] =>
	missing({
		"critic gated on allowed subagents": ship.includes("only when your actual allowed-subagent list permits it"),
		"restricted worker returns PENDING": ship.includes("Parent critic: PENDING"),
		"parent critic before merge": /The parent must run its independent\s+final-HEAD critic BEFORE merge admission/.test(
			ship,
		),
		"spec axis always invoked":
			review.includes("Always invoke the Spec sub-agent.") && !/skip the Spec sub-agent/.test(review),
		"verified absence supplied": review.includes('explicitly supply "No spec available."'),
	});

test("composed callers preserve restricted workers and verified no-spec dual axes", () => {
	const ship = readText("skills/ship-issue/SKILL.md");
	const review = readText("skills/code-review/SKILL.md");
	assert.deepEqual(missingCallerClauses(ship, review), []);
	assert.deepEqual(
		missingCallerClauses(mutate(ship, "only when your actual allowed-subagent list permits it", "always"), review),
		["critic gated on allowed subagents"],
	);
	assert.deepEqual(missingCallerClauses(mutate(ship, "Parent critic: PENDING", "critic done"), review), [
		"restricted worker returns PENDING",
	]);
	assert.deepEqual(
		missingCallerClauses(ship, mutate(review, "Always invoke the Spec sub-agent.", "skip the Spec sub-agent")),
		["spec axis always invoked"],
	);
});
