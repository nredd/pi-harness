import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const CHILD_FAILURE_STATUS = 7;
const FAILURE_EXIT_STATUS = 1;
const EXECUTABLE_MODE = 0o755;
const launcher = fileURLToPath(new URL("../../../scripts/run-vitest.ts", import.meta.url));
const BUN_COVERAGE_ARGS = [
	"--coverage",
	"--coverage.provider=istanbul",
	"--coverage.reporter=text",
	"--coverage.reporter=lcov",
	"--coverage.reportsDirectory=coverage/bun",
];

/** Runs the launcher's bun engine against a recording executable and returns its argv. */
function recordBunArgv(fixture: string, args: string[]): string[] {
	const bin = join(fixture, "bin");
	mkdirSync(bin, { recursive: true });
	const receipt = join(fixture, "argv.json");
	writeFileSync(
		join(bin, "bun"),
		`#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.env.RECEIPT, JSON.stringify(process.argv.slice(2)));\n`,
		{ mode: EXECUTABLE_MODE },
	);
	const result = spawnSync("node", [launcher, "bun", ...args], {
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RECEIPT: receipt },
		encoding: "utf8",
	});
	expect(result.error).toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
	return JSON.parse(readFileSync(receipt, "utf8"));
}

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
		expect(actual.argv.slice(2)).toEqual(["run", "--maxWorkers=1", ...BUN_COVERAGE_ARGS]);
		expect(existsSync(actual.home)).toBe(false);
		expect(result.stdout).toContain(`exit ${CHILD_FAILURE_STATUS}`);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("bun launcher owns the Istanbul signal unless coverage is explicitly disabled", () => {
	const fixture = mkdtempSync(join(tmpdir(), "pi-launcher-coverage-"));
	try {
		expect(recordBunArgv(fixture, ["--config", ".vitest.config.ts"]).slice(2)).toEqual([
			"run",
			"--config",
			".vitest.config.ts",
			...BUN_COVERAGE_ARGS,
		]);
		expect(recordBunArgv(fixture, ["canary.test.ts", "--coverage.enabled=false"]).slice(2)).toEqual([
			"run",
			"canary.test.ts",
			"--coverage.enabled=false",
		]);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("launcher refuses an unknown engine before spawning", () => {
	const result = spawnSync("node", [launcher, "unknown"], { encoding: "utf8" });
	expect(result.status).toBe(FAILURE_EXIT_STATUS);
	expect(result.stderr).toContain("Expected engine: node or bun");
});
