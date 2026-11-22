import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { SANDBOX_PREFIX, sandboxAgentDir, sandboxConfigHome, sandboxTmpdir } from "../src/sandbox.ts";
import { makeTestTempDir } from "../src/temp-dir.ts";

const NAMES = ["TMPDIR", "PI_TEST_REAL_TMPDIR", "PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
	saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
});

afterEach(() => {
	for (const name of NAMES) {
		if (saved[name] === undefined) delete process.env[name];
		else process.env[name] = saved[name];
	}
});

test("tmpdir sandbox redirects TMPDIR, nests under the real root and restores", () => {
	delete process.env.PI_TEST_REAL_TMPDIR;
	delete process.env.TMPDIR;
	delete process.env.XDG_STATE_HOME;
	const real = realpathSync(tmpdir());
	const outer = sandboxTmpdir();
	expect(process.env.XDG_STATE_HOME).toBe(join(outer.sandbox, "state"));
	expect(outer.realTmp).toBe(real);
	expect(outer.sandbox.startsWith(join(outer.realTmp, SANDBOX_PREFIX))).toBe(true);
	expect(process.env.TMPDIR).toBe(outer.sandbox);
	const inner = sandboxTmpdir();
	expect(inner.realTmp).toBe(outer.realTmp);
	expect(inner.sandbox.startsWith(join(outer.realTmp, SANDBOX_PREFIX))).toBe(true);
	expect(inner.sandbox).not.toBe(outer.sandbox);
	inner.restore();
	expect(process.env.TMPDIR).toBe(outer.sandbox);
	expect(process.env.PI_TEST_REAL_TMPDIR).toBe(outer.realTmp);
	expect(existsSync(inner.sandbox)).toBe(false);
	outer.restore();
	expect(process.env.TMPDIR).toBeUndefined();
	expect(process.env.XDG_STATE_HOME).toBeUndefined();
	expect(process.env.PI_TEST_REAL_TMPDIR).toBeUndefined();
	expect(existsSync(outer.sandbox)).toBe(false);
});

test("agent dir sandbox sets, nests and restores PI_CODING_AGENT_DIR", () => {
	delete process.env.PI_CODING_AGENT_DIR;
	const outer = sandboxAgentDir();
	expect(process.env.PI_CODING_AGENT_DIR).toBe(outer.dir);
	const inner = sandboxAgentDir(outer.dir);
	expect(inner.dir.startsWith(outer.dir)).toBe(true);
	inner.restore();
	expect(process.env.PI_CODING_AGENT_DIR).toBe(outer.dir);
	expect(existsSync(inner.dir)).toBe(false);
	outer.restore();
	expect(process.env.PI_CODING_AGENT_DIR).toBeUndefined();
	expect(existsSync(outer.dir)).toBe(false);
});

test("config home sandbox isolates XDG_CONFIG_HOME, resets between tests and restores", () => {
	process.env.PI_CODING_AGENT_DIR = "/somewhere";
	process.env.XDG_CONFIG_HOME = "/elsewhere";
	const fixture = sandboxConfigHome();
	expect(process.env.XDG_CONFIG_HOME).toBe(join(fixture.home, ".config"));
	expect(process.env.PI_CODING_AGENT_DIR).toBeUndefined();
	mkdirSync(join(fixture.home, ".config"));
	mkdirSync(join(fixture.home, ".pi"));
	writeFileSync(join(fixture.home, "keep.txt"), "x");
	process.env.PI_CODING_AGENT_DIR = "/leaked";
	process.env.XDG_CONFIG_HOME = "/leaked";
	fixture.reset();
	expect(process.env.XDG_CONFIG_HOME).toBe(join(fixture.home, ".config"));
	expect(process.env.PI_CODING_AGENT_DIR).toBeUndefined();
	expect(existsSync(join(fixture.home, ".config"))).toBe(false);
	expect(existsSync(join(fixture.home, ".pi"))).toBe(false);
	expect(existsSync(join(fixture.home, "keep.txt"))).toBe(true);
	fixture.restore();
	expect(process.env.XDG_CONFIG_HOME).toBe("/elsewhere");
	expect(process.env.PI_CODING_AGENT_DIR).toBe("/somewhere");
	expect(existsSync(fixture.home)).toBe(false);
});

test("config home sandbox restores variables that were unset", () => {
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.XDG_CONFIG_HOME;
	const fixture = sandboxConfigHome();
	fixture.restore();
	expect(process.env.XDG_CONFIG_HOME).toBeUndefined();
	expect(process.env.PI_CODING_AGENT_DIR).toBeUndefined();
});

test("sandboxes under a relative TMPDIR remove their own directories after a cwd change", ({ onTestFinished }) => {
	const root = makeTestTempDir("pi-test-lib-", onTestFinished);
	const elsewhere = makeTestTempDir("pi-test-lib-", onTestFinished);
	mkdirSync(join(root, "tmp"));
	const cwd = process.cwd();
	onTestFinished(() => process.chdir(cwd));
	process.chdir(root);
	process.env.TMPDIR = "tmp";
	const agent = sandboxAgentDir();
	const home = sandboxConfigHome();
	process.chdir(elsewhere);
	for (const dir of [agent.dir, home.home]) mkdirSync(join(elsewhere, dir), { recursive: true });
	agent.restore();
	home.restore();
	expect(readdirSync(join(root, "tmp"))).toEqual([]);
	expect(readdirSync(join(elsewhere, "tmp")).sort()).toEqual([agent.dir, home.home].map((dir) => dir.slice(4)).sort());
});
