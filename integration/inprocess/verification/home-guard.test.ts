import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { assertHomeDirectory } from "./home-guard.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("matching HOME and homedir pass", () => {
	expect(() => assertHomeDirectory("matching.test.ts", "/fixture", "/fixture")).not.toThrow();
});

test("mismatched HOME fails with the file and injection fix", () => {
	expect(() => assertHomeDirectory("offender.test.ts", "/fixture", "/real-home")).toThrow(
		/HOMEDIR GUARD: offender.test.ts:.*Inject the home directory/,
	);
});

test("missing HOME fails closed", () => {
	// Passing undefined uses the real env default; remove it only for this pure check.
	const previous = process.env.HOME;
	try {
		delete process.env.HOME;
		expect(() => assertHomeDirectory("missing.test.ts", undefined, "/real-home")).toThrow(/HOMEDIR GUARD/);
	} finally {
		if (previous === undefined) delete process.env.HOME;
		else process.env.HOME = previous;
	}
});

test("Bun negative control rejects the real todo setup before test execution", () => {
	const home = mkdtempSync(join(tmpdir(), "pi-home-guard-control-"));
	try {
		const config = join(home, "negative.config.mjs");
		writeFileSync(
			config,
			`import { mergeConfig } from ${JSON.stringify(join(root, "node_modules/vitest/dist/config.js"))};
import config from ${JSON.stringify(join(root, "packages/todo/.vitest.config.ts"))};
export default mergeConfig(config, { test: {
  setupFiles: [${JSON.stringify(join(root, "integration/inprocess/verification/home-setup.ts"))}],
  sequence: { setupFiles: "list" }
} });\n`,
		);
		const result = spawnSync(
			"bun",
			["--bun", join(root, "node_modules/vitest/vitest.mjs"), "run", "todo.invalidation.test.ts", "--config", config],
			{
				cwd: join(root, "packages/todo"),
				env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") },
				encoding: "utf8",
			},
		);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stdout + result.stderr).toMatch(/HOMEDIR GUARD: .*todo.invalidation.test.ts/);
		expect(result.stdout + result.stderr).toContain("Inject the home directory");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test.each(["beforeEach", "afterEach"])("Bun guard rejects a mismatch at the %s boundary", (boundary) => {
	const home = mkdtempSync(join(tmpdir(), "pi-home-boundary-control-"));
	try {
		const fixture = join(home, "boundary.test.ts");
		const config = join(home, "boundary.config.mjs");
		const mismatch = `process.env.HOME = ${JSON.stringify(join(home, "changed"))};`;
		writeFileSync(
			fixture,
			`import { beforeAll, test } from ${JSON.stringify(join(root, "node_modules/vitest/dist/index.js"))};
${boundary === "beforeEach" ? `beforeAll(() => { ${mismatch} });` : ""}
test("boundary mismatch", () => { ${boundary === "afterEach" ? mismatch : ""} });\n`,
		);
		writeFileSync(
			config,
			`export default { test: {
  include: [${JSON.stringify(fixture)}],
  setupFiles: [${JSON.stringify(join(root, "integration/inprocess/verification/home-setup.ts"))}]
} };\n`,
		);
		const result = spawnSync(
			"bun",
			["--bun", join(root, "node_modules/vitest/vitest.mjs"), "run", "--config", config],
			{ cwd: home, env: { ...process.env, HOME: home }, encoding: "utf8" },
		);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stdout + result.stderr).toMatch(/HOMEDIR GUARD: .*boundary.test.ts/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("four full Bun suites keep the shared setup and launcher in their gates", async () => {
	for (const directory of [
		"packages/subscription-router",
		"packages/preset",
		"packages/resource-sampler",
		"integration/inprocess",
	]) {
		const manifest = JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8"));
		expect(manifest.scripts["test:bun"]).toMatch(/^node ..\/..\/scripts\/run-vitest.ts bun(?: --maxWorkers=1)?$/);
		expect(manifest.scripts.check).toContain("npm run test:bun");
		const config = await import(join(root, directory, "vitest.config.ts"));
		expect(config.default.test.setupFiles).toEqual([
			directory === "integration/inprocess"
				? "./verification/home-setup.ts"
				: "../../integration/inprocess/verification/home-setup.ts",
		]);
	}
});
