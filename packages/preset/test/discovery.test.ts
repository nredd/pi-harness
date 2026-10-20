// Real Pi 1.3.0 resource discovery over this package, as a configured local package.
// No model calls, no auth: only the resource loader and package manager run, against a temporary
// agent directory and project, so nothing under the real `~/.pi` is read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	DefaultPackageManager,
	DefaultResourceLoader,
	parseFrontmatter,
	type ResolvedResource,
	SettingsManager,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { manifest, pkgRoot } from "./support.ts";

const SKILLS = ["code-review", "coding-like-redd", "get-it-merged", "ship-issue"];
const THEMES = ["belafonte-day", "tokyonight-storm"];

/**
 * Environment that can redirect Pi's filesystem reads/writes. Pi resolves `HOME` (user skills
 * under `~/.agents/skills`), `PI_CODING_AGENT_DIR` (default agent dir), and `os.tmpdir()` (scratch)
 * at call time, so they are saved, pointed into the sandbox, and restored. `PI_OFFLINE` stops any
 * network-capable path. The agent dir is also passed explicitly to every Pi API used below, so
 * the env redirection is a second layer, not the only one.
 *
 * Limit: this runs in the test process, after `@earendil-works/pi-coding-agent` was imported, so a
 * constant computed at import time would not see the redirection. Pi 1.3.0 computes none of the
 * paths used here at import time (verified in `dist/config.js` and `dist/core/package-manager.js`).
 * A different Pi version would need a subprocess with a clean env instead.
 */
const ISOLATED_ENV = [
	"HOME",
	"USERPROFILE",
	"PI_CODING_AGENT_DIR",
	"PI_OFFLINE",
	"PI_PACKAGE_DIR",
	"TMPDIR",
	"TMP",
	"TEMP",
	"XDG_CONFIG_HOME",
	"XDG_CACHE_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
] as const;

interface Sandbox {
	root: string;
	home: string;
	agentDir: string;
	cwd: string;
	settingsManager: SettingsManager;
}

/**
 * Temp HOME + agent dir + project that configures this package as a user-scope local package.
 * Results never depend on (or touch) the real user's resources, auth, or process state.
 */
async function withSandbox<T>(fn: (box: Sandbox) => Promise<T>): Promise<T> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-preset-discovery-")));
	const home = join(root, "home");
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const scratch = join(root, "tmp");
	for (const dir of [home, agentDir, cwd, scratch]) mkdirSync(dir);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkgRoot] }));
	const saved = new Map(ISOLATED_ENV.map((key) => [key, process.env[key]]));
	const redirected: Record<(typeof ISOLATED_ENV)[number], string> = {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
		PI_PACKAGE_DIR: join(root, "pi-package"),
		TMPDIR: scratch,
		TMP: scratch,
		TEMP: scratch,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_CACHE_HOME: join(home, ".cache"),
		XDG_DATA_HOME: join(home, ".local/share"),
		XDG_STATE_HOME: join(home, ".local/state"),
	};
	Object.assign(process.env, redirected);
	try {
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		return await fn({ root, home, agentDir, cwd, settingsManager });
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	}
}

async function load({ agentDir, cwd, settingsManager }: Sandbox): Promise<DefaultResourceLoader> {
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true });
	await loader.reload();
	return loader;
}

test("sandbox redirects every env var that can move Pi's reads, and restores them", async () => {
	const before = ISOLATED_ENV.map((key) => process.env[key]);
	await withSandbox(async (box) => {
		for (const key of ISOLATED_ENV) {
			const value = process.env[key];
			assert.ok(value?.startsWith(box.root) || key === "PI_OFFLINE", `${key} -> ${value}`);
		}
		assert.equal(tmpdir(), join(box.root, "tmp"));
		assert.equal(process.env.PI_OFFLINE, "1");
	});
	assert.deepEqual(
		ISOLATED_ENV.map((key) => process.env[key]),
		before,
	);
});

test("host is the declared Pi 1.3.0 release", () => {
	assert.equal(VERSION, "1.3.0");
	assert.match(manifest().devDependencies["@earendil-works/pi-coding-agent"] ?? "", new RegExp(`-${VERSION}\\.tgz$`));
});

test("resource loader discovers the footer, skills, and themes without diagnostics", () =>
	withSandbox(async (box) => {
		const loader = await load(box);

		const extensions = loader.getExtensions();
		assert.deepEqual(extensions.errors, []);
		// Unfiltered: with a sandboxed HOME/agent dir nothing but the package may contribute.
		assert.deepEqual(
			extensions.extensions.map((e) => e.path),
			[join(pkgRoot, "extensions/expanded-footer.ts")],
		);

		const skills = loader.getSkills();
		assert.deepEqual(skills.diagnostics, []);
		assert.ok(skills.skills.every((s) => s.filePath.startsWith(`${pkgRoot}/`)));
		assert.deepEqual(skills.skills.map((s) => s.name).sort(), SKILLS);
		for (const skill of skills.skills) assert.ok(skill.description.length > 0, skill.name);

		const themes = loader.getThemes();
		assert.deepEqual(themes.diagnostics, []);
		const names = themes.themes.map((t) => t.name);
		for (const name of THEMES) assert.ok(names.includes(name), `theme ${name} loaded`);
	}));

test("footer-only source filters load the extension without skills, prompts or themes", () =>
	withSandbox(async (box) => {
		box.settingsManager.setPackages([
			{
				source: pkgRoot,
				extensions: ["extensions/expanded-footer.ts"],
				skills: [],
				prompts: [],
				themes: [],
			},
		]);
		const loader = await load(box);
		assert.deepEqual(loader.getExtensions().errors, []);
		assert.deepEqual(
			loader.getExtensions().extensions.map((e) => e.path),
			[join(pkgRoot, "extensions/expanded-footer.ts")],
		);
		assert.deepEqual(loader.getSkills().skills, []);
		assert.deepEqual(loader.getPrompts().prompts, []);
		assert.ok(loader.getThemes().themes.every((theme) => !THEMES.includes(theme.name ?? "")));
	}));

test("an existing global skill of the same name wins; the packaged one is reported, not loaded", () =>
	withSandbox(async (box) => {
		const globalSkill = join(box.home, ".agents/skills/ship-issue");
		mkdirSync(globalSkill, { recursive: true });
		writeFileSync(join(globalSkill, "SKILL.md"), "---\nname: ship-issue\ndescription: Local override.\n---\nLocal.\n");
		const skills = (await load(box)).getSkills();
		const winner = skills.skills.find((s) => s.name === "ship-issue");
		assert.equal(winner?.filePath, join(globalSkill, "SKILL.md"));
		const collisions = skills.diagnostics.filter((d) => d.type === "collision");
		assert.equal(collisions.length, 1);
		assert.equal(collisions[0]?.collision?.loserPath, join(pkgRoot, "skills/ship-issue/SKILL.md"));
		assert.equal(collisions[0]?.collision?.winnerPath, join(globalSkill, "SKILL.md"));
	}));

test("package manager resolves the same resources and a package install root", () =>
	withSandbox(async (box) => {
		const manager = new DefaultPackageManager({
			cwd: box.cwd,
			agentDir: box.agentDir,
			settingsManager: box.settingsManager,
		});
		const [configured] = manager.listConfiguredPackages();
		assert.equal(configured?.scope, "user");
		assert.equal(configured?.installedPath, pkgRoot);

		const resolved = await manager.resolve(async () => "skip");
		const enabled = (list: ResolvedResource[]): string[] =>
			list.filter((r) => r.enabled && r.path.startsWith(pkgRoot)).map((r) => r.path);
		assert.deepEqual(enabled(resolved.extensions), [join(pkgRoot, "extensions/expanded-footer.ts")]);
		assert.deepEqual(
			enabled(resolved.skills)
				.map((p) => p.split("/").at(-2))
				.sort(),
			SKILLS,
		);
		assert.deepEqual(
			enabled(resolved.themes)
				.map((p) => p.split("/").at(-1))
				.sort(),
			THEMES.map((t) => `${t}.json`),
		);
	}));

test("declared subagent agents resolve inside the package and parse with Pi's frontmatter reader", () => {
	const { pi } = manifest();
	assert.deepEqual(pi.subagents, { agents: ["./agents"] });
	const dir = resolve(pkgRoot, pi.subagents.agents[0] ?? "");
	assert.ok(dir.startsWith(`${pkgRoot}/`));
	const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
	assert.equal(files.length, 7);
	for (const file of files) {
		const { frontmatter } = parseFrontmatter(readFileSync(join(dir, file), "utf8"));
		assert.equal(frontmatter.name, file.replace(/\.md$/, ""));
		assert.ok(typeof frontmatter.description === "string" && frontmatter.description.length > 0, file);
	}
});
