// Strict static checks on the packaged resources: agents, skills, themes, settings defaults,
// declared external dependencies, and the host-import surface of the footer code.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import Schema from "typebox/schema";
import { test } from "vitest";
import { frontmatterOf, type Json, manifest, packedFiles, pkgRoot, readJson, readText, walk } from "./support.ts";

const AGENTS = ["architect", "code-reviewer", "critic", "debugger", "general-purpose", "researcher", "verifier"];
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

test("exactly the seven agents ship, each a well-formed definition", () => {
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

test("agents carry no model or logical-role references (strict roles are not implemented yet)", () => {
	for (const file of [...walk("agents"), ...walk("skills")]) {
		const text = readText(file);
		assert.ok(!/^model\s*:/m.test(text), `${file}: model: key`);
		assert.ok(!/\brole\s*:/i.test(text), `${file}: role: reference`);
	}
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

test("ship-issue is generalized and keeps its workflow and reviewer model requirements", () => {
	const text = readText("skills/ship-issue/SKILL.md");
	assert.ok(!text.includes("redd/issue-"), "personal branch prefix");
	assert.ok(text.includes("<prefix>/issue-<N>"));
	assert.ok(text.includes('subagent_type: "critic", model: "sonnet"'));
	assert.ok(text.includes('subagent_type: "critic", model: "opus"'));
	for (const heading of ["## 2. Worktree", "## 5. Gate", "## 7. Review round", "## 9. Merge and clean up"]) {
		assert.ok(text.includes(heading), heading);
	}
	assert.ok(text.includes("`gh pr merge --squash --auto --delete-branch`"));
	assert.ok(readText("skills/code-review/SKILL.md").includes('model: "openai-codex/gpt-6.1-sol"'));
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
