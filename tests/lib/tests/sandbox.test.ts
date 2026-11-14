import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { SANDBOX_PREFIX, sandboxAgentDir, sandboxConfigHome, sandboxTmpdir } from "../src/sandbox.ts";

const NAMES = ["TMPDIR", "PI_TEST_REAL_TMPDIR", "PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME"] as const;
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
	const real = realpathSync(tmpdir());
	const outer = sandboxTmpdir();
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
