import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { assertHomeDirectory } from "./home-guard.ts";

const FAILURE_EXIT_STATUS = 1;
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

test("Bun runs the injected todo setup with the guard active", () => {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "pi-home-guard-control-")));
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
		expect(result.status, result.stdout + result.stderr).toBe(0);
		expect(result.stdout + result.stderr).not.toContain("HOMEDIR GUARD");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test.each(["beforeEach", "afterEach"])(
	"Bun guard rejects a mismatch at the %s boundary through a linked temp home",
	(boundary) => {
		const directory = mkdtempSync(join(tmpdir(), "pi-home-boundary-control-"));
		const linked = join(directory, "linked-home");
		mkdirSync(join(directory, "home"));
		symlinkSync(join(directory, "home"), linked, "dir");
		// Bun/Vite's bundled config loader fails through macOS /var aliases. Exercise
		// that path on every OS, then give the child one canonical cwd/config path.
		const home = realpathSync(linked);
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
			expect(result.status).toBe(FAILURE_EXIT_STATUS);
			expect(result.stdout + result.stderr).toMatch(/HOMEDIR GUARD: .*boundary.test.ts/);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
);

test("guarded suites keep the shared setup and launcher in their gates", async () => {
	for (const directory of [
		"packages/subscription-router",
		"packages/preset",
		"packages/resource-sampler",
		"integration/inprocess",
		"packages/todo",
		"packages/subagents",
	]) {
		const manifest = JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8"));
		if (directory === "packages/subagents") {
			// Full Bun remains blocked by the unrelated workflow stack-line issue #174.
			expect(manifest.scripts["test:bun"]).toContain(
				"node ../../scripts/run-vitest.ts bun test/resource-loader-home.test.ts",
			);
			expect(manifest.scripts["test:bun"]).toContain("bun test test/session-scenarios.test.ts");
		} else {
			expect(manifest.scripts["test:bun"]).toMatch(
				/^node ..\/..\/scripts\/run-vitest.ts bun(?: --maxWorkers=1| --config .vitest.config.ts)? --coverage --coverage.provider=istanbul --coverage.reporter=text --coverage.reporter=lcov --coverage.reportsDirectory=coverage\/bun$/,
			);
		}
		expect(manifest.scripts.check).toContain("npm run test:bun");
		const config = await import(
			join(root, directory, directory === "packages/todo" ? ".vitest.config.ts" : "vitest.config.ts")
		);
		expect(config.default.test.setupFiles).toContain(
			directory === "integration/inprocess"
				? "./verification/home-setup.ts"
				: "../../integration/inprocess/verification/home-setup.ts",
		);
	}
});
