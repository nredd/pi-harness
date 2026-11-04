import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const CHILD_FAILURE_STATUS = 7;
const FAILURE_EXIT_STATUS = 1;
const EXECUTABLE_MODE = 0o755;
const launcher = fileURLToPath(new URL("../../../scripts/run-vitest.ts", import.meta.url));
const loaderUrl = new URL(
	"../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js",
	import.meta.url,
).href;

test("launcher isolates HOME before Bun starts, forwards arguments and propagates failure with cleanup", () => {
	const fixture = mkdtempSync(join(tmpdir(), "pi-launcher-test-"));
	try {
		const bin = join(fixture, "bin");
		mkdirSync(bin);
		const receipt = join(fixture, "receipt.json");
		writeFileSync(
			join(bin, "bun"),
			`#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";
import { homedir } from "node:os";
writeFileSync(process.env.RECEIPT, JSON.stringify({ home: process.env.HOME, resolved: homedir(), xdg: process.env.XDG_CONFIG_HOME, argv: process.argv.slice(2) }));
process.exitCode = ${CHILD_FAILURE_STATUS};\n`,
			{ mode: EXECUTABLE_MODE },
		);
		const result = spawnSync("node", [launcher, "bun", "--maxWorkers=1"], {
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RECEIPT: receipt },
			encoding: "utf8",
		});
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(CHILD_FAILURE_STATUS);
		const actual = JSON.parse(readFileSync(receipt, "utf8"));
		expect(actual.home).not.toBe(process.env.HOME);
		expect(actual.resolved).toBe(actual.home);
		expect(actual.xdg).toBe(join(actual.home, ".config"));
		expect(actual.argv[0]).toBe("--bun");
		// Package arguments come first; scripts/tests/test_coverage_producers.py pins the appended coverage arguments.
		expect(actual.argv.slice(2, 4)).toEqual(["run", "--maxWorkers=1"]);
		expect(existsSync(actual.home)).toBe(false);
		expect(result.stdout).toContain(`exit ${CHILD_FAILURE_STATUS}`);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("launcher keeps a real extension load out of the shared jiti cache", () => {
	const fixture = mkdtempSync(join(tmpdir(), "pi-launcher-jiti-"));
	try {
		// `shared` stands in for the ambient TMPDIR every run inherits; no other process writes here.
		const shared = join(fixture, "shared-tmp");
		const bin = join(fixture, "bin");
		mkdirSync(shared);
		mkdirSync(bin);
		const marker = join(fixture, "loaded.txt");
		const extension = join(fixture, "extension", "probe.ts");
		mkdirSync(dirname(extension));
		writeFileSync(
			extension,
			`import { appendFileSync } from "node:fs";\nconst label: string = "loaded";\nexport default function () { appendFileSync(${JSON.stringify(marker)}, label + "\\n"); }\n`,
		);
		// The fake engine runs Pi's real extension loader, which is what writes `$TMPDIR/jiti` entries.
		const engine = join(bin, "bun");
		writeFileSync(
			engine,
			`#!/usr/bin/env node\nconst { loadExtensions } = await import(${JSON.stringify(loaderUrl)});
const { errors } = await loadExtensions([${JSON.stringify(extension)}], ${JSON.stringify(fixture)});
if (errors.length > 0) throw new Error(JSON.stringify(errors));\n`,
			{ mode: EXECUTABLE_MODE },
		);
		const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: shared };
		// The outer run may already carry the opt-out; the launcher must set it on its own.
		delete env.JITI_FS_CACHE;

		// Negative control: the same load outside the launcher does write the shared cache.
		const direct = spawnSync(engine, [], { env, encoding: "utf8" });
		expect(direct.status, direct.stderr).toBe(0);
		expect(readdirSync(join(shared, "jiti")).some((name) => name.startsWith("extension-probe."))).toBe(true);
		rmSync(join(shared, "jiti"), { recursive: true });

		const launched = spawnSync("node", [launcher, "bun"], { env, encoding: "utf8" });
		expect(launched.status, launched.stderr).toBe(0);
		expect(readFileSync(marker, "utf8")).toBe("loaded\nloaded\n");
		expect(existsSync(join(shared, "jiti"))).toBe(false);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("workspace scripts that bypass the launcher disable jiti's fs cache themselves", () => {
	const root = fileURLToPath(new URL("../../../", import.meta.url));
	const packages = readdirSync(join(root, "packages")).map((name) => join("packages", name));
	const unguarded: string[] = [];
	let direct = 0;
	for (const workspace of [...packages, "integration/inprocess"]) {
		const manifest = join(root, workspace, "package.json");
		if (!existsSync(manifest)) continue;
		const scripts: Record<string, string> = JSON.parse(readFileSync(manifest, "utf8")).scripts ?? {};
		for (const [name, script] of Object.entries(scripts)) {
			for (const command of script.split("&&").map((part) => part.trim())) {
				const launch = /^((?:\w+=\S+ )*)(?:vitest run|bun test)\b/.exec(command);
				if (!launch) continue;
				direct += 1;
				const [, prefix = ""] = launch;
				if (!prefix.split(" ").includes("JITI_FS_CACHE=false")) unguarded.push(`${workspace} ${name}: ${command}`);
			}
		}
	}
	// Non-vacuous: direct `vitest run` / `bun test` launches exist today.
	expect(direct).toBeGreaterThan(0);
	expect(unguarded).toEqual([]);
});

test("launcher refuses an unknown engine before spawning", () => {
	const result = spawnSync("node", [launcher, "unknown"], { encoding: "utf8" });
	expect(result.status).toBe(FAILURE_EXIT_STATUS);
	expect(result.stderr).toContain("Expected engine: node or bun");
});
