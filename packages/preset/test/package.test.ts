// Package contract: public-publishable metadata, exact content allowlist from `npm pack`, host
// peers vs devDependencies, privacy scan of every shipped byte, and README honesty.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { manifest, packedFiles, pkgRoot, readText, walk } from "./support.ts";

const SHIPPED_DIRS = ["agents", "extensions", "lib", "licenses", "settings", "skills", "themes"];
const EXPECTED_FILES = [
	"LICENSE",
	"NOTICE.md",
	"README.md",
	"package.json",
	"agents/architect.md",
	"agents/code-reviewer.md",
	"agents/critic.md",
	"agents/debugger.md",
	"agents/general-purpose.md",
	"agents/researcher.md",
	"agents/verifier.md",
	"extensions/expanded-footer.ts",
	"lib/footer-cache.ts",
	"lib/footer-quota.ts",
	"licenses/Apache-2.0-tokyonight.nvim.txt",
	"licenses/CC-BY-SA-4.0.txt",
	"licenses/MIT-enkia-tokyo-night-vscode-theme.txt",
	"settings/personal-defaults.json",
	"skills/code-review/SKILL.md",
	"skills/coding-like-redd/SKILL.md",
	"skills/get-it-merged/SKILL.md",
	"skills/ship-issue/SKILL.md",
	"themes/belafonte-day.json",
	"themes/tokyonight-storm.json",
].sort();
const HOST_PEERS = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"];
const HOST_PACKAGES = ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", ...HOST_PEERS, "typebox"];
/** Require a domain TLD so pinned npm specs are not mistaken for addresses. */
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b/i;
// Kept local to the pack privacy gate; diagnostics additionally scan binary streams and auth formats.
const TOKEN_PATTERN =
	/\b(?:sk|pk)-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{36,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}/;
const HOST_RELEASE_TARBALL =
	/^https:\/\/github\.com\/nredd\/pi\/releases\/download\/v1\.3\.0-nredd\.\d+\/earendil-works-pi-[a-z-]+-1\.3\.0\.tgz$/;

test("metadata: public, versioned, correctly attributed", () => {
	const pkg = manifest();
	assert.equal(pkg.name, "@nredd/pi-preset");
	assert.equal(pkg.version, "0.3.0");
	assert.ok(!("private" in pkg));
	assert.deepEqual(pkg.publishConfig, { access: "public" });
	assert.deepEqual(pkg.repository, {
		type: "git",
		url: "git+https://github.com/nredd/pi-harness.git",
		directory: "packages/preset",
	});
	assert.ok(pkg.keywords.includes("pi-package"));
	assert.deepEqual(Object.keys(pkg.scripts).sort(), ["check", "format", "lint", "test", "test:bun", "typecheck"]);
	for (const hook of ["preinstall", "install", "postinstall", "prepare", "prepublishOnly", "prepack"]) {
		assert.ok(!(hook in pkg.scripts), `lifecycle script '${hook}'`);
	}
});

test("pi manifest declares exactly the preset resources, all inside the package", () => {
	const { pi } = manifest();
	assert.deepEqual(pi, {
		extensions: ["./extensions/expanded-footer.ts"],
		skills: ["./skills"],
		themes: ["./themes"],
		subagents: { agents: ["./agents"] },
	});
	for (const path of [...pi.extensions, ...pi.skills, ...pi.themes, ...pi.subagents.agents]) {
		assert.ok(path.startsWith("./") && !path.includes(".."), path);
	}
	assert.ok(!("prompts" in pi), "no prompts are shipped");
	assert.ok(!SHIPPED_DIRS.includes("keybindings"));
});

test("host packages are peers (*) and exact-pinned devDependencies; none are bundled dependencies", () => {
	const pkg = manifest();
	assert.deepEqual(Object.keys(pkg.peerDependencies).sort(), HOST_PEERS);
	for (const name of HOST_PEERS) assert.equal(pkg.peerDependencies[name], "*");
	assert.ok(!pkg.dependencies && !pkg.bundledDependencies && !pkg.bundleDependencies, "no runtime dependencies");
	for (const name of HOST_PACKAGES) assert.ok(!(name in (pkg.dependencies ?? {})), name);
	// The host is the core fork's immutable release tarball of upstream 1.3.0; everything else is an exact version.
	for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"])
		assert.match(pkg.devDependencies[name] ?? "", HOST_RELEASE_TARBALL, name);
	for (const [name, range] of Object.entries(pkg.devDependencies))
		if (!name.startsWith("@earendil-works/pi-")) assert.match(range, /^\d+\.\d+\.\d+$/, name);
});

test("npm pack ships exactly the allowlist", () => {
	assert.deepEqual(packedFiles(), EXPECTED_FILES);
	const { files } = manifest();
	assert.deepEqual(
		[...files].sort(),
		[...SHIPPED_DIRS.map((d) => `${d}/`), "LICENSE", "NOTICE.md", "README.md"].sort(),
	);
	for (const file of packedFiles()) {
		assert.ok(!/(^|\/)(test|node_modules)\//.test(file), file);
		assert.ok(!/(^|\/)(tsconfig|biome)\.json$|\.gitignore$|package-lock/.test(file), file);
	}
	for (const dir of SHIPPED_DIRS)
		assert.deepEqual(
			walk(dir).filter((f) => !EXPECTED_FILES.includes(f)),
			[],
			dir,
		);
});

test("privacy email scan distinguishes addresses from exact npm pins", () => {
	for (const address of ["person@example.invalid", "first.last+tag@sub.example.invalid"])
		assert.ok(EMAIL_PATTERN.test(address));
	assert.ok(!EMAIL_PATTERN.test("npm:@nredd/pi-preset@0.2.0"));
});

test("privacy token scan rejects synthetic npm credentials at the length boundary", () => {
	for (const length of [36, 37]) assert.ok(TOKEN_PATTERN.test(`npm_${"aB1".repeat(13).slice(0, length)}`));
	assert.ok(!TOKEN_PATTERN.test(`npm_${"a".repeat(35)}`));
});

test("shipped files contain no machine, network, account, or credential details", () => {
	const FORBIDDEN: [RegExp, string][] = [
		[/\/Users\/[^/\s]+/, "macOS home path"],
		[/\/home\/[a-z][\w-]*\//, "linux home path"],
		[/[A-Za-z]:\\Users\\/, "windows home path"],
		[/\.meep\.net|\bmeep\b/i, "LAN domain"],
		[/\b(?:192\.168|10\.\d+|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+\b/, "private IP"],
		[/tailscale|tailnet|magicdns/i, "tailnet"],
		[/\bHA_TOKEN\b|\bhome\.meep|homeassistant|home-assistant/i, "home automation"],
		[TOKEN_PATTERN, "token"],
		[/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
		[EMAIL_PATTERN, "e-mail address"],
		[/enterprise\.local|personal\.local|auth\.json|\.ssh\/|id_ed25519/i, "local manifest or credential file"],
		[/\bKeychron\b|Karabiner|MX Master|MonitorControl/i, "hardware"],
	];
	for (const file of packedFiles()) {
		if (file === "licenses/CC-BY-SA-4.0.txt" || file.endsWith(".txt")) continue; // third-party legal text, hashed separately
		const text = readFileSync(`${pkgRoot}/${file}`, "utf8");
		for (const [pattern, label] of FORBIDDEN) assert.ok(!pattern.test(text), `${file}: ${label}`);
	}
	for (const file of packedFiles().filter((f) => f.endsWith(".txt"))) {
		const text = readFileSync(`${pkgRoot}/${file}`, "utf8");
		assert.ok(!/\/Users\/|\.meep\.net/.test(text), file);
	}
});

test("nothing from global, machine, or private configuration ships", () => {
	const names = packedFiles().map((f) => f.toLowerCase());
	for (const banned of [
		"agents.md",
		"claude.md",
		"keybindings.json",
		"mcp.json",
		"subagents.json",
		"enterprise",
		"manifest",
		"auth",
		"chezmoi",
		"homeassistant",
		"home-assistant",
		"reverse-engineer",
	]) {
		assert.ok(!names.some((n) => n.split("/").at(-1)?.includes(banned) || n.includes(`/${banned}`)), banned);
	}
});

test("README states public publication and keeps the pending work explicit", () => {
	const readme = readText("README.md");
	for (const needle of [
		"Published to npm as `@nredd/pi-preset` (public)",
		"not a supported release",
		"npm:@nredd/pi-preset@0.3.0",
		'"packageAgents": false',
		"test/footer-render.test.ts",
		"no installer, no profile resolver, no activation path",
		"No `role:` references are introduced",
		"**Pending.**",
		"**pending** too",
		"Retirement of the old global copies is **not done here",
		"Pending, not claimed",
		"1.3.0",
	]) {
		assert.ok(readme.includes(needle), needle);
	}
});
