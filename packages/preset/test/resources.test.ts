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

test("shell-less agents disclose their limits in the first sentence and stop on blocked commands", () => {
	for (const agent of AGENTS) {
		const { frontmatter, body } = frontmatterOf(`agents/${agent}.md`);
		const description = String(frontmatter.description);
		const firstSentence = description.split(/[.!?](?:\s|$)/)[0] ?? "";
		if (["architect", "code-reviewer", "critic", "researcher"].includes(agent)) {
			assert.ok(firstSentence.includes("no shell/ssh: cannot run commands"), agent);
			assert.ok(body.includes("FIRST turn, before any tool calls"), agent);
			assert.ok(body.includes("stop rather than spending a run on partial substitutes"), agent);
		} else {
			assert.ok(!description.includes("no shell/ssh"), agent);
		}
	}
	assert.ok(
		String(frontmatterOf("agents/critic.md").frontmatter.description).includes(
			"except existing tests via py_test/cargo_test",
		),
	);
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

const section = (text: string, heading: string): string => {
	const start = text.indexOf(`## ${heading}`);
	if (start < 0) return "";
	const next = text.indexOf("\n## ", start + 3);
	return text.slice(start, next < 0 ? undefined : next);
};

/** Every `Checked:` admission bullet must scope itself to the two axes or the critic. */
const checkedBulletsScoped = (policy: string): boolean => {
	const bullets = section(policy, "3. Admit one candidate")
		.split("\n")
		.filter((line) => line.startsWith("- ") && line.includes("`Checked:`"));
	return (
		bullets.length >= 2 &&
		bullets.every((line) => /Standards and Spec axes|for the critic/.test(line)) &&
		bullets.some((line) => line.includes("Never synthesize `Checked:` evidence for the critic"))
	);
};

/** The parent must itself arm pinned auto-merge, monitor natively and loop, never hand off to itself. */
const drivesWholeList = (policy: string): boolean => {
	const drive = section(policy, "4. Merge and advance (parent)");
	return (
		/gh pr merge <N> --auto --<method> --match-head-commit <full-sha>/.test(drive) &&
		drive.includes("monitor_start") &&
		/Arming auto-merge merges IMMEDIATELY when the base branch has no effective required checks/.test(drive) &&
		/A 403, plan-gated error, unknown, or uncertain bypass eligibility is NOT protected/.test(drive) &&
		/readable applicable rulesets and classic branch protection establish effective required checks for this base \*and\* that the merging caller cannot bypass them/.test(
			drive,
		) &&
		/Backend not proven protected: keep auto-merge OFF[^\n]*gh pr merge <N> --<method> --match-head-commit <full-sha>/.test(
			drive,
		) &&
		/Never use `--admin` or any bypass/.test(drive) &&
		drive.includes("return to step 3 for the next unblocked PR") &&
		drive.includes("every requested PR is merged") &&
		!/hand (?:the|it to the) parent/i.test(drive) &&
		!/hand(?:s)? the parent/i.test(section(policy, "3. Admit one candidate")) &&
		/PARENT driver[^\n]*never hands the merge to "the parent": it IS the parent/.test(policy) &&
		/DELEGATED worker[^\n]*no merge authority/.test(policy)
	);
};

test("shipping resources require exact-HEAD review, parent monitoring, and no forced model or unpinned auto-merge", () => {
	const review = readText("skills/code-review/SKILL.md");
	const ship = readText("skills/ship-issue/SKILL.md");
	const merge = readText("skills/get-it-merged/SKILL.md");
	for (const text of [review, ship, merge]) {
		assert.doesNotMatch(text, /model:\s*"/);
		for (const line of text.split("\n").filter((l) => /gh pr merge\b[^\n]*--auto\b/.test(l))) {
			assert.match(line, /--match-head-commit/, `unpinned auto-merge: ${line}`);
		}
	}
	assert.match(review, /no `model` unless the user named one/);
	assert.match(ship, /use `\/skill:code-review` for the separate Standards/);
	assert.match(ship, /shared skill selects parent background versus delegated blocking calls/);
	assert.match(ship, /Delegated worker: keep auto-merge off/);
	assert.match(ship, /follow `\/skill:get-it-merged` steps 3-4 as a one-PR train/);
	assert.match(ship, /Do not duplicate or weaken it here/);
	assert.match(merge, /Whole-PR review receipts: record the original full merge-base and current full HEAD/);
	assert.match(merge, /corrective-delta reviews are supplemental only/);
	assert.match(merge, /Run the parent's own final critic on the exact HEAD/);
	assert.match(merge, /native session-kit monitors/);
	assert.match(merge, /Do not require a latest-main rebase solely because the base advanced/);
	assert.match(merge, /frozen combined gate immediately before\npublish\/deploy/);
	assert.match(merge, /Keep model turns and subagents for substantive work/);
	assert.match(ship, /original SHA-bound invocation, tool-routing metadata, native output/);
});

test("code-reviewer template is the literal skeleton the receipt parser accepts", () => {
	const reviewer = readText("agents/code-reviewer.md");
	assert.match(reviewer, /`Checked:` has one `- ` line per standard rule or spec requirement/);
	assert.match(reviewer, /A clean review still lists what it checked/);
	assert.match(reviewer, /Spec axis with no spec supplied: use the skeleton/);
	assert.match(reviewer, /^Axis: <Standards\|Spec>\nReviewed HEAD: <full-40-character-sha>\nChecked:\n- /m);
	assert.match(reviewer, /\nFindings:\n\[hard\|judgement\]/);
	assert.doesNotMatch(reviewer, /^Findings: \S/m);
});

test("get-it-merged admits critic receipts without fabricated review evidence", () => {
	const merge = readText("skills/get-it-merged/SKILL.md");
	const ship = readText("skills/ship-issue/SKILL.md");
	assert.ok(checkedBulletsScoped(merge));
	assert.ok(
		!checkedBulletsScoped(
			merge.replace(
				"Confirm the Standards and Spec axes have `Checked:` evidence and every reviewer has a named identity/model",
				"Confirm all three reviews have `Checked:` evidence and a named identity/model",
			),
		),
	);
	assert.match(merge, /original invocation's full SHA/);
	assert.match(merge, /tool-routing metadata/);
	assert.match(ship, /Accept only the critic's native `No findings\.` or structured finding/);
});

test("get-it-merged parent drives the whole list; negative controls", () => {
	const merge = readText("skills/get-it-merged/SKILL.md");
	assert.ok(drivesWholeList(merge));
	const drive = section(merge, "4. Merge and advance (parent)");
	const mutate = (from: string | RegExp, to: string) => {
		assert.ok(typeof from === "string" ? merge.includes(from) : from.test(merge), `fixture drift: ${from}`);
		return typeof from === "string" ? merge.split(from).join(to) : merge.replace(from, to);
	};
	assert.ok(!drivesWholeList(mutate("--match-head-commit <full-sha>", "")));
	assert.ok(!drivesWholeList(mutate("return to step 3 for the next unblocked PR", "stop")));
	assert.ok(!drivesWholeList(mutate("monitor_start", "poll")));
	assert.ok(
		!drivesWholeList(
			mutate("A 403, plan-gated error, unknown, or uncertain bypass eligibility is NOT protected", "A 403 is fine"),
		),
	);
	assert.ok(!drivesWholeList(mutate("the merging caller cannot bypass them", "the merging caller can bypass them")));
	assert.ok(
		!drivesWholeList(
			mutate("Backend not proven protected: keep auto-merge OFF", "Backend not proven protected: arm it"),
		),
	);
	assert.ok(!drivesWholeList(mutate("Never use `--admin` or any bypass", "")));
	assert.ok(!drivesWholeList(mutate("every requested PR is merged", "one PR is merged")));
	assert.ok(!drivesWholeList(mutate(drive, `${drive}\n- Hand the parent the PR URL and stop.`)));
	assert.ok(!drivesWholeList(mutate(/## 4\. Merge and advance \(parent\)[\s\S]*?(?=\n## 5)/, "")));
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

test("code-review binds both axes to an immutable HEAD and supports nested blocking calls", () => {
	const review = readText("skills/code-review/SKILL.md");
	assert.match(review, /git rev-parse HEAD/);
	assert.match(review, /For a non-PR review, use the resolved fixed point as `<reviewed-base>`/);
	assert.match(
		review,
		/git merge-base <pr-base> HEAD.*record its full SHA as `<reviewed-base>`, and preserve it across every later HEAD change/,
	);
	assert.match(review, /git diff <reviewed-base>\.\.\.<reviewed-head>/);
	assert.match(review, /with the preserved `<reviewed-base>`/);
	assert.match(review, /A corrective-delta review is supplemental only/);
	assert.match(review, /A top-level parent spawns/);
	assert.match(review, /A delegated session omits `run_in_background`/);
	const promptBinding =
		/The full original reviewed-base SHA, full reviewed HEAD SHA, and immutable whole-PR diff command/g;
	assert.equal(review.match(promptBinding)?.length, 2, "both axis prompts carry the immutable range");
	assert.doesNotMatch(
		review.replace("with the preserved `<reviewed-base>`", "with a new `<reviewed-base>`"),
		/with the preserved `<reviewed-base>`/,
	);
	assert.doesNotMatch(
		review.replace("A corrective-delta review is supplemental only", "A corrective-delta review replaces the axes"),
		/A corrective-delta review is supplemental only/,
	);
	const merge = readText("skills/get-it-merged/SKILL.md");
	assert.doesNotMatch(
		merge.replace("corrective-delta reviews are supplemental only", "corrective-delta reviews replace both axes"),
		/corrective-delta reviews are supplemental only/,
	);
	assert.doesNotMatch(
		review.replace(
			"A delegated session omits `run_in_background`",
			"A delegated session uses `run_in_background: true`",
		),
		/omits `run_in_background`/,
	);
});

test("single-issue parents retain terminal ownership and nested reviews use blocking calls", () => {
	const ship = readText("skills/ship-issue/SKILL.md");
	const reviews = section(ship, "7. Review round -- exact final HEAD");
	const retainsOwner = (policy: string) => {
		const handoff = section(policy, "9. Handoff and cleanup");
		return (
			/Parent completion: continue until this PR is `MERGED`/.test(handoff) &&
			/genuine external blocker has a named owner and an armed continuation monitor/.test(handoff)
		);
	};
	assert.match(reviews, /use `\/skill:code-review` for the separate Standards/);
	assert.match(reviews, /shared skill selects parent background versus delegated blocking calls/);
	assert.match(reviews, /both full SHAs and the original whole-PR range/);
	assert.ok(retainsOwner(ship));
	assert.ok(!retainsOwner(ship.replace(/^- Parent completion:[^\n]*\n/m, "")));
});
