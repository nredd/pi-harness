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
// The package root export, not a dist path: the fake engine runs outside Vitest's resolver.
const piUrl = import.meta.resolve("@earendil-works/pi-coding-agent");

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

test("launcher keeps the account's Rust toolchain reachable under the isolated HOME", () => {
	const fixture = mkdtempSync(join(tmpdir(), "pi-launcher-rust-"));
	try {
		const bin = join(fixture, "bin");
		mkdirSync(bin);
		writeFileSync(
			join(bin, "bun"),
			`#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";
writeFileSync(process.env.RECEIPT, JSON.stringify({ home: process.env.HOME, cargo: process.env.CARGO_HOME ?? null, rustup: process.env.RUSTUP_HOME ?? null }));\n`,
			{ mode: EXECUTABLE_MODE },
		);
		const run = (toolchain: Record<string, string>) => {
			const receipt = join(fixture, `receipt-${Object.keys(toolchain).length}.json`);
			const { CARGO_HOME: _cargo, RUSTUP_HOME: _rustup, ...inherited } = process.env;
			const result = spawnSync("node", [launcher, "bun"], {
				env: { ...inherited, ...toolchain, PATH: `${bin}:${process.env.PATH}`, RECEIPT: receipt },
				encoding: "utf8",
			});
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(0);
			return JSON.parse(readFileSync(receipt, "utf8"));
		};
		// rustup's proxies resolve both homes from HOME when unset, so the isolated HOME would hide them.
		// The launcher runs on Node, whose `userInfo()` reads passwd; Bun's follows this suite's isolated HOME.
		const account = spawnSync("node", ["-p", "require('node:os').userInfo().homedir"], {
			encoding: "utf8",
		}).stdout.trim();
		const defaults = run({});
		expect(defaults.home).not.toBe(account);
		expect(defaults.cargo).toBe(join(account, ".cargo"));
		expect(defaults.rustup).toBe(join(account, ".rustup"));
		const explicit = run({ CARGO_HOME: join(fixture, "cargo"), RUSTUP_HOME: join(fixture, "rustup") });
		expect(explicit.cargo).toBe(join(fixture, "cargo"));
		expect(explicit.rustup).toBe(join(fixture, "rustup"));
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
			`#!/usr/bin/env node\nconst { discoverAndLoadExtensions } = await import(${JSON.stringify(piUrl)});
const { errors } = await discoverAndLoadExtensions([${JSON.stringify(extension)}], ${JSON.stringify(fixture)}, ${JSON.stringify(join(fixture, "agent"))});
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

/** `vitest` or `bun test` as a command head, bare or through a package runner, after any env assignments. */
const DIRECT_LAUNCH =
	/^((?:\w+=\S*\s+)*)(?:(?:npx|bunx|bun\s+x|npm\s+exec)\s+(?:-\S+\s+)*)?(?:vitest|bun\s+test)(?=\s|$)/;
const SHELL_SEPARATOR = /&&|\|\||;|\|/;

/** Return each direct test launch in a script and whether it carries `JITI_FS_CACHE=false`. */
function directLaunches(script: string): { command: string; guarded: boolean }[] {
	return script.split(SHELL_SEPARATOR).flatMap((part) => {
		const command = part.trim();
		const launch = DIRECT_LAUNCH.exec(command);
		if (!launch) return [];
		const [, assignments = ""] = launch;
		return [{ command, guarded: assignments.split(/\s+/).includes("JITI_FS_CACHE=false") }];
	});
}

test("the direct-launch matcher sees every shell form of a test command", () => {
	expect(directLaunches("vitest")).toEqual([{ command: "vitest", guarded: false }]);
	expect(directLaunches("tsc --noEmit; vitest run")).toEqual([{ command: "vitest run", guarded: false }]);
	expect(directLaunches("a || npx --yes vitest bench | tee out")).toEqual([
		{ command: "npx --yes vitest bench", guarded: false },
	]);
	expect(directLaunches("bunx vitest && bun x vitest && npm exec vitest")).toHaveLength(3);
	expect(directLaunches("X=1 JITI_FS_CACHE=false bun test a.test.ts")).toEqual([
		{ command: "X=1 JITI_FS_CACHE=false bun test a.test.ts", guarded: true },
	]);
	// The launcher's own arguments are not a direct launch.
	expect(directLaunches("node ../../scripts/run-vitest.ts bun test/a.test.ts")).toEqual([]);
	expect(directLaunches("vitest-coverage-merge && bun tests")).toEqual([]);
});

test("scripts that bypass the launcher disable jiti's fs cache themselves", () => {
	const root = fileURLToPath(new URL("../../../", import.meta.url));
	const packages = readdirSync(join(root, "packages")).map((name) => join("packages", name));
	const direct: string[] = [];
	const unguarded: string[] = [];
	for (const workspace of [".", ...packages, "integration/inprocess"]) {
		// A workspace without a manifest is a broken checkout, not a reason to skip it.
		const scripts: Record<string, string> =
			JSON.parse(readFileSync(join(root, workspace, "package.json"), "utf8")).scripts ?? {};
		for (const [name, script] of Object.entries(scripts)) {
			for (const { command, guarded } of directLaunches(script)) {
				direct.push(`${workspace} ${name}`);
				if (!guarded) unguarded.push(`${workspace} ${name}: ${command}`);
			}
		}
	}
	expect(unguarded).toEqual([]);
	// Exact, so a new direct launcher is a deliberate edit here and in docs/verification-engines.md.
	expect(direct.sort()).toEqual([
		"packages/dev-tools test",
		"packages/plan-mode test",
		"packages/plan-mode test:dist",
		"packages/preset test",
		"packages/resource-sampler test",
		"packages/session-kit test",
		"packages/session-kit test:bun",
		"packages/subagents bench",
		"packages/subagents test:bun",
		"packages/subagents test:e2e",
		"packages/subagents test:watch",
		"packages/subagents test:workflow-examples",
		"packages/subscription-router test",
		"packages/todo test",
	]);
});

test("launcher refuses an unknown engine before spawning", () => {
	const result = spawnSync("node", [launcher, "unknown"], { encoding: "utf8" });
	expect(result.status).toBe(FAILURE_EXIT_STATUS);
	expect(result.stderr).toContain("Expected engine: node or bun");
});
