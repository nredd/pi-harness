/** Native graph controls for the public-SDK stack fixture: guard and scenarios live in `tests/fixtures/native-*.mjs`. */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedHomeEnv } from "@nredd/pi-test-lib/isolated-home";
import { runTree } from "@nredd/pi-test-lib/run-tree";
import { expect, it } from "vitest";

/** Same bound as `runtime-surface.test.ts`: a loaded runner must not time out a healthy child. */
const CHILD_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 40_000;

/** What a native child prints: each scenario fills only its own fields. */
interface Receipt {
	first?: string;
	results?: { isError: boolean; text: string }[];
	pending?: number;
	cleaned?: boolean;
	imports?: string[];
	publicSdk?: boolean;
	error?: string;
}

/**
 * Run a scenario script in a native child without provider credentials, then remove every fixture path.
 *
 * Parameters:
 *   executable (string): runtime to launch.
 *   script (string): fixture file name under `tests/fixtures/`.
 *   args (string[]): script arguments.
 *
 * Returns:
 *   Promise<Receipt>: the child's JSON receipt.
 */
async function run(executable: string, script: string, args: string[] = []): Promise<Receipt> {
	const root = mkdtempSync(join(tmpdir(), "stack-headless-process-"));
	const home = join(root, "home");
	const temp = join(root, "tmp");
	mkdirSync(home);
	mkdirSync(temp);
	try {
		const result = await runTree(
			executable,
			[fileURLToPath(new URL(`./tests/fixtures/${script}`, import.meta.url)), ...args],
			{
				cwd: fileURLToPath(new URL(".", import.meta.url)),
				env: {
					PATH: process.env.PATH,
					...isolatedHomeEnv(home),
					TMPDIR: temp,
					TMP: temp,
					TEMP: temp,
					PI_OFFLINE: "1",
					PI_NO_LOCAL_LLM: "1",
					JITI_FS_CACHE: "false",
				},
				timeoutMs: CHILD_TIMEOUT_MS,
			},
		);
		expect(result.error).toBeUndefined();
		expect(result.timedOut).toBe(false);
		expect(result.status, result.stderr || result.stdout).toBe(0);
		return JSON.parse(result.stdout) as Receipt;
	} finally {
		rmSync(root, { recursive: true, force: true });
		expect(existsSync(root)).toBe(false);
	}
}

it(
	"prompts a real public stack and refuses an unavailable tool without fork testing exports",
	async () => {
		const result = await run(process.execPath, "native-success.mjs");
		expect(result).toMatchObject({ first: "STACK OK", pending: 0, cleaned: true, results: [{ isError: true }] });
		expect(result.results?.[0]?.text).toContain("missing_tool");
		// The shared public harness was evaluated, and no fork testing specifier was ever resolved.
		expect(result.imports).toEqual(
			expect.arrayContaining([expect.stringMatching(/(?:pi-test-lib\/harness|harness\.ts)$/)]),
		);
		expect(
			result.imports?.filter((specifier) => /(?:pi-coding-agent|pi-tui)\/(?:dist\/)?testing/.test(specifier)),
		).toEqual([]);
	},
	TEST_TIMEOUT_MS,
);

// Node's resolve hook runs before package resolution, so every host reports the guard's own error.
it.each([
	"@earendil-works/pi-coding-agent/testing",
	"@earendil-works/pi-coding-agent/testing/interactive",
	"@earendil-works/pi-tui/testing",
])(
	"the guard refuses injected fork import %s",
	async (specifier) => {
		const result = await run("node", "native-injected.mjs", [specifier]);
		expect(result.publicSdk).toBe(true);
		expect(result.error).toBe(`FORK_BOUNDARY: ${specifier}`);
	},
	TEST_TIMEOUT_MS,
);
